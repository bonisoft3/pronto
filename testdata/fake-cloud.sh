#!/bin/sh
# The stand-in for gcloud, docker and curl (release-flow.test.ts): every call is appended to
# $FAKE_LOG, and each answers as the real one would on a project where everything exists, with
# the image tags it was told of remembered in $FAKE_STATE. It reaches nothing.
tool=$(basename "$0")
args="$*"
echo "$tool $args" >> "$FAKE_LOG"
case "$tool" in
curl)
  case "$args" in *write-out*) printf 200 ;; esac
  exit 0 ;;
docker)
  case "$args" in *"config --format json"*) cat "$FAKE_COMPOSE" ;; esac
  exit 0 ;;
esac
# A call made to fail, by the pattern in $FAKE_FAIL.
if [ -n "$FAKE_FAIL" ] && echo "$args" | grep -Eq "$FAKE_FAIL"; then echo "fake failure: $args" >&2; exit 1; fi
hex() { printf %s "$1" | shasum -a 256 | cut -d' ' -f1; }
case "$args" in
*"run services replace"*)
  f=$(echo "$args" | sed -E 's/.*replace ([^ ]+).*/\1/')
  # The service as replaced keeps its job hash label, which a describe returns.
  sn=$(grep -m1 -E '^[[:space:]]*"?name"?:' "$f" | sed -E 's/.*name"?:[[:space:]]*"?([^",]*).*/\1/')
  grep -m1 'pronto-job' "$f" | sed -E 's/.*pronto-job:[[:space:]]*"?([^"]*)"?.*/\1/' > "$FAKE_STATE/job-$sn"
  echo "  replace $f is $(grep -m1 -E '^[[:space:]]*"?name"?:' "$f" | sed -E 's/.*name"?:[[:space:]]*"?([^",]*).*/\1/')" >> "$FAKE_LOG" ;;
esac
case "$args" in
*"builds submit"*)
  cfg=$(echo "$args" | sed -nE 's/.*--config ([^ ]+).*/\1/p')
  mkdir -p "$FAKE_STATE/builds"
  cp "$cfg" "$FAKE_STATE/builds/$$.yaml"
  echo "  build $FAKE_STATE/builds/$$.yaml" >> "$FAKE_LOG"
  # An image built is new content: its digest moves with each build of its repository.
  for ref in $(grep -o '\.tags=[^ ]*' "$cfg" | sed 's/^\.tags=//' | sort -u); do
    g="$FAKE_STATE/gen-$(hex "${ref%:*}")"
    echo $(( $(cat "$g" 2>/dev/null || echo 0) + 1 )) > "$g"
    # The push moves the tag to the new image.
    rm -f "$FAKE_STATE/tag-$(hex "$ref")"
  done
  case "$args" in *--async*) echo "build-$$" ;; esac ;;
*"run services describe"*"--format json"*)
  sn=$(echo "$args" | sed -E 's/.*run services describe ([^ ]+).*/\1/')
  if [ -s "$FAKE_STATE/job-$sn" ]; then printf '{"status":{"latestReadyRevisionName":"r1","latestCreatedRevisionName":"r1"},"spec":{"template":{"metadata":{"labels":{"pronto-job":"%s"}}}}}\n' "$(cat "$FAKE_STATE/job-$sn")"
  else echo '{"status":{}}'; fi ;;
*"builds describe"*) echo SUCCESS ;;
*"builds get-default-service-account"*) echo "projects/p/serviceAccounts/1-compute@developer.gserviceaccount.com" ;;
*"projects describe"*) echo 424242 ;;
*"artifacts docker images describe"*)
  ref=$(echo "$args" | sed -E 's/.*images describe ([^ ]+).*/\1/')
  key=$(hex "$ref")
  if [ -f "$FAKE_STATE/tag-$key" ]; then d=$(cat "$FAKE_STATE/tag-$key")
  else
    case "$ref" in *:src-*) echo "NOT_FOUND: $ref" >&2; exit 1 ;; esac
    d="sha256:$(hex "digest $ref $(cat "$FAKE_STATE/gen-$(hex "${ref%:*}")" 2>/dev/null)")"
  fi
  echo "$d" ;;
*"artifacts docker tags add"*)
  src=$(echo "$args" | sed -E 's/.*tags add ([^ ]+) ([^ ]+).*/\1/')
  dst=$(echo "$args" | sed -E 's/.*tags add ([^ ]+) ([^ ]+).*/\2/')
  case "$src" in *@*) d=${src#*@} ;; *) d="sha256:$(hex "digest $src")" ;; esac
  echo "$d" > "$FAKE_STATE/tag-$(hex "$dst")" ;;
*"secrets versions access"*) echo fake-secret ;;
*"auth print-access-token"*) echo fake-token ;;
*"--format json"*) echo '{"settings":{"databaseFlags":[]}}' ;;
esac
exit 0

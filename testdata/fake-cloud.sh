#!/bin/sh
# The stand-in for gcloud, docker and curl (release-flow.test.ts): every call is appended to
# $FAKE_LOG, and each answers as the real one would on a project where everything exists, with
# the image tags it was told of remembered in $FAKE_STATE. It reaches nothing.
tool=$(basename "$0")
args="$*"
echo "$tool $args" >> "$FAKE_LOG"
case "$tool" in
curl)
  # A service answers /health with its revision's name, as its Caddyfile does.
  out=""; for a in "$@"; do [ "$prev" = "--output" ] && out="$a"; prev="$a"; done
  case "$args" in */health*) [ -z "$out" ] || printf r1 > "$out" ;; esac
  case "$args" in *write-out*) printf 200 ;; esac
  exit 0 ;;
docker)
  case "$args" in *"config --format json"*) cat "$FAKE_COMPOSE" ;; esac
  exit 0 ;;
esac
# A call refused once, as IAM refuses a write that raced another on the same policy, by the pattern in $FAKE_RACE.
if [ -n "$FAKE_RACE" ] && echo "$args" | grep -Eq "$FAKE_RACE" && [ ! -e "$FAKE_STATE/raced" ]; then touch "$FAKE_STATE/raced"; echo "  raced $args" >> "$FAKE_LOG"; echo "ERROR: (gcloud.run.services.add-iam-policy-binding) ABORTED: There were concurrent policy changes. Please retry the whole read-modify-write with exponential backoff." >&2; exit 1; fi
# A call made to fail, by the pattern in $FAKE_FAIL.
if [ -n "$FAKE_FAIL" ] && echo "$args" | grep -Eq "$FAKE_FAIL"; then echo "fake failure: $args" >&2; exit 1; fi
hex() { printf %s "$1" | shasum -a 256 | cut -d' ' -f1; }
case "$args" in
*"run services replace"*)
  f=$(echo "$args" | sed -E 's/.*replace ([^ ]+).*/\1/')
  # gcloud reads YAML 1.1: a bare on, off, yes or no is a boolean where Cloud Run wants a string.
  if grep -Eq ':[[:space:]]+(on|off|yes|no|On|Off|Yes|No|ON|OFF|YES|NO|y|n)[[:space:]]*$' "$f"; then echo "ERROR: (gcloud.run.services.replace) Expected type <class 'str'> for field value, found False" >&2; exit 1; fi
  # The service as replaced keeps its job hash label, which a describe returns.
  sn=$(grep -m1 -E '^[[:space:]]*"?name"?:' "$f" | sed -E 's/.*name"?:[[:space:]]*"?([^",]*).*/\1/')
  grep -m1 'pronto-job' "$f" | sed -E 's/.*pronto-job"?:[[:space:]]*"?([^",]*)"?.*/\1/' > "$FAKE_STATE/job-$sn"
  echo "  replace $f is $(grep -m1 -E '^[[:space:]]*"?name"?:' "$f" | sed -E 's/.*name"?:[[:space:]]*"?([^",]*).*/\1/')" >> "$FAKE_LOG" ;;
esac
# Cloud Storage objects (the release lock), each with a generation, kept in $FAKE_STATE; a write or
# a removal with --if-generation-match holds only where the generation is that (0: no object).
case "$args" in
*"storage cp "*gs://*|*"storage cat "*|*"storage objects describe "*|*"storage rm "*)
  obj=$(echo "$args" | grep -oE 'gs://[^ ]+' | head -1)
  k="$FAKE_STATE/gcs-$(hex "$obj")"
  cur=$(cat "$k.gen" 2>/dev/null || echo 0)
  want=$(echo "$args" | sed -nE 's/.*--if-generation-match=([0-9]+).*/\1/p')
  if [ -n "$want" ] && [ "$want" != "$cur" ]; then echo "ERROR: HTTPError 412: At least one of the pre-conditions you specified did not hold." >&2; exit 1; fi
  case "$args" in
  *"storage cp "*)
    src=$(echo "$args" | sed -E 's/.*storage cp ([^ ]+) .*/\1/')
    n=$(( $(cat "$FAKE_STATE/gcs-counter" 2>/dev/null || echo 0) + 1 )); echo $n > "$FAKE_STATE/gcs-counter"
    cp "$src" "$k.body"; echo "$n" > "$k.gen"; echo "  wrote $obj" >> "$FAKE_LOG" ;;
  *)
    if [ "$cur" = 0 ]; then echo "ERROR: $obj not found: 404" >&2; exit 1; fi
    case "$args" in
    *"storage cat "*) cat "$k.body" ;;
    *"objects describe "*) echo "$cur" ;;
    *"storage rm "*) rm -f "$k.body" "$k.gen"; echo "  removed $obj" >> "$FAKE_LOG" ;;
    esac ;;
  esac
  exit 0 ;;
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
  if [ -s "$FAKE_STATE/job-$sn" ]; then printf '{"status":{"latestReadyRevisionName":"r1","latestCreatedRevisionName":"r1","traffic":[{"revisionName":"r1","percent":100,"tag":"next","url":"https://next---fake.run.app"}]},"spec":{"template":{"metadata":{"labels":{"pronto-job":"%s"}}}}}\n' "$(cat "$FAKE_STATE/job-$sn")"
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
*"secrets versions access"*)
  sec=$(echo "$args" | sed -E 's/.*--secret ([^ ]+).*/\1/')
  if [ -f "$FAKE_STATE/secret-$(hex "$sec")" ]; then cat "$FAKE_STATE/secret-$(hex "$sec")"; else echo fake-secret; fi ;;
*"secrets create "*|*"secrets versions add "*)
  # The value a secret is given on stdin is kept, so the next access reads it back.
  sec=$(echo "$args" | sed -E 's/.*secrets (create|versions add) ([^ ]+).*/\2/')
  cat > "$FAKE_STATE/secret-$(hex "$sec")" ;;
*"auth print-access-token"*) echo fake-token ;;
*"--format json"*) echo '{"settings":{"databaseFlags":[]}}' ;;
esac
exit 0

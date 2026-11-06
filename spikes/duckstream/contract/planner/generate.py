import argparse
import hashlib
import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent
JAR = ROOT.parent.parent / "compiler/.cache/feldera-0.367.0.jar"
JAR_SHA256 = "d08430de8b34ae997b72c44eb9a9274b25955a41af35e7c6997e7e459d3283ab"


def prepare(jar, output):
    hasher = hashlib.sha256()
    with jar.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(chunk)
    digest = hasher.hexdigest()
    if digest != JAR_SHA256:
        raise ValueError(f"Compiler artifact hash mismatch: {digest}")
    version = subprocess.run(
        ["java", "-jar", str(jar), "--version"], check=True, capture_output=True, text=True
    ).stdout.strip()
    if "0.367.0" not in version:
        raise ValueError(version)
    classes = output / "classes"
    classes.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["javac", "--release", "19", "-cp", str(jar), "-d", str(classes),
         str(ROOT / "ContractPlanner.java")], check=True
    )
    return {"feldera": version, "jar_sha256": digest, "classes": str(classes)}


def generate(source, target, jar, classes):
    target.mkdir(parents=True, exist_ok=True)
    return subprocess.run(
        ["java", "-ea", "-cp", f"{classes}:{jar}",
         "org.dbsp.sqlCompiler.compiler.ContractPlanner", str(source), str(target)],
        capture_output=True, text=True,
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--jar", type=pathlib.Path, default=JAR)
    parser.add_argument("--output", type=pathlib.Path, default=ROOT / "results")
    parser.add_argument("--source", type=pathlib.Path)
    args = parser.parse_args()
    jar, output = args.jar.resolve(), args.output.resolve()
    metadata = prepare(jar, output)
    sources = [args.source.resolve()] if args.source else sorted((ROOT / "fixtures").glob("*.sql"))
    for source in sources:
        target = output / source.stem
        process = generate(source, target, jar, metadata["classes"])
        (target / "compiler.txt").write_text(process.stdout + process.stderr)
        if process.returncode:
            raise RuntimeError(process.stdout + process.stderr)
    metadata.pop("classes")
    (output / "compiler.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(json.dumps(metadata))


if __name__ == "__main__":
    main()

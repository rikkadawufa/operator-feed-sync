"""Import the Airtable credential and the generated workflows into the local n8n, then publish them.

The token goes from .env into a temp file, is copied into the container for the import
and deleted on both sides right after. Nothing secret is printed.
"""
import argparse
import json
import subprocess
import tempfile
from pathlib import Path

try:
    from .envfile import ROOT, load_env, mask, require
except ImportError:
    from envfile import ROOT, load_env, mask, require

WORKFLOW_IDS = ["wfSyncErrors", "wfFeedSync"]


def run(command, values):
    result = subprocess.run(command, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode != 0:
        raise SystemExit(f"Command failed: {' '.join(command[:4])}…\n{mask(result.stderr[-800:], values)}")
    return result.stdout


def import_credentials(values):
    credentials = [{"id": "airtableTokenCred01", "name": "Airtable (demo base)", "type": "airtableTokenApi",
                    "data": {"accessToken": require(values, "AIRTABLE_TOKEN")}}]
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".json", delete=False) as handle:
        local_path = Path(handle.name)
        json.dump(credentials, handle)
    container_path = "/tmp/feed-sync-credentials.json"
    try:
        run(["docker", "compose", "cp", str(local_path), f"n8n:{container_path}"], values)
        run(["docker", "compose", "exec", "-T", "n8n", "n8n", "import:credentials", "--input", container_path], values)
    finally:
        local_path.unlink(missing_ok=True)
        subprocess.run(["docker", "compose", "exec", "-T", "-u", "root", "n8n", "rm", "-f", container_path], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-credentials", action="store_true", help="only re-import and publish workflows")
    args = parser.parse_args()
    values = load_env()
    if not args.skip_credentials:
        import_credentials(values)
        print("Imported the Airtable credential.")
    run(["docker", "compose", "exec", "-T", "n8n", "n8n", "import:workflow", "--separate", "--input=/files/workflows/"], values)
    print(f"Imported {len(WORKFLOW_IDS)} workflows.")
    for workflow_id in WORKFLOW_IDS:
        run(["docker", "compose", "exec", "-T", "n8n", "n8n", "publish:workflow", f"--id={workflow_id}"], values)
    run(["docker", "compose", "restart", "n8n"], values)
    print("Published both workflows and restarted n8n (the webhook takes a few seconds to register).")


if __name__ == "__main__":
    main()

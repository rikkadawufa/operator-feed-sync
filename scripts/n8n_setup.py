"""Import the Airtable credential and the generated workflows into the local n8n, then publish them.

The token goes from .env into a temp file, is copied into the container for the import
and deleted on both sides right after. Nothing secret is printed.

--cloudsim does the same for the Cloud workflows on the n8n-cloudsim container, with the
Settings nodes filled from .env (the base ID and Slack URL a buyer would type in by hand).
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
CLOUD_WORKFLOW_IDS = ["wfSyncErrorsCloud", "wfFeedSyncCloud"]


def run(command, values):
    result = subprocess.run(command, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode != 0:
        raise SystemExit(f"Command failed: {' '.join(command[:4])}…\n{mask(result.stderr[-800:], values)}")
    return result.stdout


def copy_in_and_run(service, local_path, container_path, command, values):
    try:
        run(["docker", "compose", "cp", str(local_path), f"{service}:{container_path}"], values)
        run(["docker", "compose", "exec", "-T", service, *command, container_path], values)
    finally:
        local_path.unlink(missing_ok=True)
        subprocess.run(["docker", "compose", "exec", "-T", "-u", "root", service, "rm", "-f", container_path], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def temp_json(data):
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".json", delete=False) as handle:
        json.dump(data, handle)
        return Path(handle.name)


def import_credentials(service, values):
    credentials = [{"id": "airtableTokenCred01", "name": "Airtable (demo base)", "type": "airtableTokenApi",
                    "data": {"accessToken": require(values, "AIRTABLE_TOKEN")}}]
    copy_in_and_run(service, temp_json(credentials), "/tmp/feed-sync-credentials.json", ["n8n", "import:credentials", "--input"], values)


def import_cloud_workflows(values):
    filled = {"airtableBaseId": require(values, "AIRTABLE_BASE_ID"), "slackWebhookUrl": require(values, "SLACK_WEBHOOK_URL")}
    for workflow_id in CLOUD_WORKFLOW_IDS:
        workflow = json.loads((ROOT / "workflows-cloud" / f"{workflow_id}.json").read_text(encoding="utf-8"))
        for node in workflow["nodes"]:
            if node["name"] == "Settings":
                for field in node["parameters"]["assignments"]["assignments"]:
                    field["value"] = filled[field["name"]]
        if workflow_id == "wfFeedSyncCloud":
            workflow["settings"]["errorWorkflow"] = "wfSyncErrorsCloud"
        copy_in_and_run("n8n-cloudsim", temp_json(workflow), f"/tmp/{workflow_id}.json", ["n8n", "import:workflow", "--input"], values)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--skip-credentials", action="store_true", help="only re-import and publish workflows")
    parser.add_argument("--cloudsim", action="store_true", help="set up the Cloud workflows on the n8n-cloudsim container")
    args = parser.parse_args()
    values = load_env()
    service = "n8n-cloudsim" if args.cloudsim else "n8n"
    ids = CLOUD_WORKFLOW_IDS if args.cloudsim else WORKFLOW_IDS
    if not args.skip_credentials:
        import_credentials(service, values)
        print("Imported the Airtable credential.")
    if args.cloudsim:
        import_cloud_workflows(values)
    else:
        run(["docker", "compose", "exec", "-T", "n8n", "n8n", "import:workflow", "--separate", "--input=/files/workflows/"], values)
    print(f"Imported {len(ids)} workflows.")
    for workflow_id in ids:
        run(["docker", "compose", "exec", "-T", service, "n8n", "publish:workflow", f"--id={workflow_id}"], values)
    run(["docker", "compose", "restart", service], values)
    print("Published both workflows and restarted n8n (the webhook takes a few seconds to register).")


if __name__ == "__main__":
    main()

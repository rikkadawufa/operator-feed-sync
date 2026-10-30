import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PREFIXES = ("AIRTABLE_", "SLACK_", "N8N_", "GENERIC_")
SECRETS = ("AIRTABLE_TOKEN", "SLACK_WEBHOOK_URL", "N8N_ENCRYPTION_KEY")


def load_env(path=ROOT / ".env"):
    values = {}
    env_path = Path(path)
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, value = stripped.split("=", 1)
            values[key.strip()] = value.strip()
    for key, value in os.environ.items():
        if key in values or key.startswith(PREFIXES):
            values[key] = value
    return values


def require(values, name):
    if not values.get(name):
        raise SystemExit(f"Missing {name} in .env")
    return values[name]


def mask(text, values):
    """Replace every secret value that appears in text with ***."""
    text = str(text)
    for name in SECRETS:
        secret = values.get(name)
        if secret:
            text = text.replace(secret, "***")
    return text

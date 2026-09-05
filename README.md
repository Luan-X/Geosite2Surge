# Geosite2Surge

Geosite to Surge rule converter.

This repository keeps the converter source on `main`. Generated Surge rules are published by GitHub Actions to the `generated` branch.

## Usage

```ini
[Rule]
RULE-SET,https://raw.githubusercontent.com/Luan-X/Geosite2Surge/refs/heads/generated/data/google,PROXY
RULE-SET,https://raw.githubusercontent.com/Luan-X/Geosite2Surge/refs/heads/generated/data/cn,DIRECT
```

Replace `google` or `cn` with any geosite list name from `v2fly/domain-list-community`.

## Build Locally

```bash
git clone --depth 1 https://github.com/v2fly/domain-list-community.git /tmp/domain-list-community
npm run build -- --data-dir /tmp/domain-list-community/data --out-dir data --branch generated
```

## Automation

GitHub Actions runs every 30 minutes and can also be triggered manually. The workflow:

1. Runs tests.
2. Clones `v2fly/domain-list-community`.
3. Converts geosite data to Surge rule sets.
4. Publishes `data/` and the generated rule index README to the `generated` branch.

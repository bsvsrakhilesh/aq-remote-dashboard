# Deployment

## Local production stack

Copy `.env.example` to `.env` if you want to change defaults, then run:

```powershell
docker compose up --build -d
docker compose ps
```

Open `http://localhost:3000`. Stop the stack with `docker compose down`. Add `-v` only when you intentionally want to delete imported datasets and registry state.

`AXIOM_INPUT_DIR` controls the host directory scanned for existing top-level CSV files. The directory is mounted read-only. Browser uploads are persisted in the Docker volume.

## Internet deployment

GitHub hosts the source, CI, security scans, and versioned images in GitHub Container Registry. The frontend can be hosted on [GitHub Pages](github-pages.md). Pages cannot run FastAPI, so connect the frontend to a separately hosted HTTPS API or deploy the complete Compose stack to a container host.

For a public deployment, place a TLS reverse proxy or managed load balancer in front of the web container and add authentication. Restrict request rates and CPU/memory, use a private object store for uploaded data, scan uploads, back up the state store, and set retention rules before accepting sensitive files.

Images are published on every push to `main` and every `v*` tag:

```text
ghcr.io/<owner>/<repository>-api
ghcr.io/<owner>/<repository>-web
```

The workflow emits provenance and an SBOM for each image.

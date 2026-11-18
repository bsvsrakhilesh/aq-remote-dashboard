# GitHub Pages

Public frontend: https://bsvsrakhilesh.github.io/air-quality/

The `Deploy GitHub Pages` workflow builds the frontend on pushes to `main` that change frontend files or the workflow. It can also be started manually from Actions. GitHub Pages must use **GitHub Actions** as its publishing source.

GitHub Pages hosts static content; it cannot run this application's Python/FastAPI backend. Without a configured backend, the published site displays an explicit connection-setup page. It does not expose nonfunctional upload controls or pretend to have live datasets.

## Connect a backend

1. Deploy the API using the backend image or the instructions in [deployment.md](deployment.md). Use HTTPS, persistent storage, and suitable authentication/access controls before accepting public uploads. The API remains a single-process local workspace unless you add multi-user isolation.
2. Include `https://bsvsrakhilesh.github.io` in `AXIOM_CORS_ORIGINS` on the API server. An origin does not include the `/air-quality/` path. CORS is not authentication.
3. In repository **Settings → Secrets and variables → Actions → Variables**, create `VITE_API_BASE_URL` with the HTTPS server URL, for example `https://analysis.example.org`. Do not append `/api`; the frontend already includes it in every endpoint.
4. Run **Actions → Deploy GitHub Pages → Run workflow**. Changing a variable alone does not rebuild the site.
5. Verify that the published workspace loads its catalog and that uploads and analyses work against that server.

This variable is public configuration embedded in the JavaScript bundle. Never put a token, password, or secret in a `VITE_` variable. No source datasets, local uploads, or `.axiom` state are included in the Pages artifact.

## Local checks

Normal development continues to use Vite's `/api` proxy. A regular build also uses same-origin API requests, which preserves the Docker/Nginx deployment.

To build the Pages setup screen in PowerShell:

```powershell
$env:VITE_BASE_PATH='/air-quality/'
$env:VITE_STATIC_HOST='true'
npm.cmd --prefix frontend run build
npm.cmd --prefix frontend run preview -- --host 127.0.0.1
```

Open `http://127.0.0.1:4173/air-quality/`. To preview a connected deployment, set `VITE_API_BASE_URL` to the hosted HTTPS API before building. Remove the temporary environment variables when returning to normal local builds.

Navigation uses query parameters, so Pages does not need an SPA rewrite rule. The Vite base path also prefixes JavaScript, styles, and the favicon.

References: [GitHub Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages), [Vite GitHub Pages deployment](https://vite.dev/guide/static-deploy#github-pages).

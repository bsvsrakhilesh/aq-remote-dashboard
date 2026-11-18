# Contributing to Axiom

Create a focused branch from `main`, keep source datasets out of Git, and include tests for behavior changes. Before opening a pull request, run:

```powershell
python -m ruff check backend
python -m pytest -q
npm --prefix frontend run lint
npm --prefix frontend run build
docker compose config --quiet
```

Commit messages should be short, imperative, and explain one coherent change. UI changes should preserve keyboard access, responsive behavior, empty/loading/error states, and the existing visual system.

Statistical changes must document assumptions, handle missing data deliberately, expose sample sizes, and report effect sizes alongside p-values where applicable.

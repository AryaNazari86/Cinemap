# Cinemap

A 3D map of films where neighbours are movies the same people rate alike.

The repo has two independent halves. They share no code; the only hand-off is one
JSON file.

```
ml/    Training: MovieLens data, notebooks, the matrix factorization model
web/   The website: Django + a three.js frontend, deployed to Vercel
```

```
ml/models/*.pt ──► ml/scripts/export_map.py ──► web/galaxy/static/galaxy/data/movies.json
```

## ml/

Python with PyTorch, pandas and UMAP (`ml/requirements.txt`). Data and model
weights stay local; see `ml/data/README.md` for downloading MovieLens.

After training a new model, rebuild the website's map data:

```bash
.venv/bin/python ml/scripts/export_map.py
```

## web/

Django serves the page; Vite bundles `web/src/` into the `galaxy` app's static
folder. The server needs only `web/requirements.txt` (Django, WhiteNoise).

```bash
cd web && npm install && ./dev.sh   # http://localhost:8000
```

Deploy on Vercel with **Root Directory** set to `web` and `DJANGO_SECRET_KEY`
set in the project's environment variables.

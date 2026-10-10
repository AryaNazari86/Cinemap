# Data

Cinemap is trained on MovieLens data from GroupLens Research. The files are not
committed; download them from https://grouplens.org/datasets/movielens/ and unzip
into `data/raw/`:

- `data/raw/ml-latest-small/` — 100K ratings, used for fast pipeline development
- `data/raw/ml-32m/` — 32M ratings through October 2023, used for the real training run

`data/processed/` holds Parquet caches written by `cinemap/data.py`.

## Citation

F. Maxwell Harper and Joseph A. Konstan. 2015. The MovieLens Datasets: History and
Context. ACM Transactions on Interactive Intelligent Systems (TiiS) 5, 4: 19:1–19:19.
https://doi.org/10.1145/2827872

The data is licensed for non-commercial use; see the README inside each dataset folder.

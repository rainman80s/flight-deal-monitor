"""Production entry point: gunicorn -w 1 --threads 4 -b 0.0.0.0:8080 wsgi:app

Use exactly ONE worker: the search loop runs inside the worker process, and more
workers would mean duplicate searches and duplicate calls.
"""
import logging

from flightmon.config import load_config
from flightmon.notify import make_notifier
from flightmon.providers import make_fare_provider
from flightmon.server import create_app, start_search_loop
from flightmon.store import Store

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

cfg = load_config()
store = Store(cfg.db_path)
notifier = make_notifier(cfg)
start_search_loop(cfg, store, make_fare_provider(cfg), notifier)
app = create_app(cfg, store, notifier)

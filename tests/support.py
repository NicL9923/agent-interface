"""Helpers shared by the Python test files, which run as scripts from the repository root.

Files in tests/ import this directly. Test files elsewhere put tests/ on sys.path first:
    sys.path.insert(0, str(Path(__file__).resolve().parents[N] / "tests"))
"""
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load_source(relative_path, name=None):
    """Execute a repository file as a new module, without adding it to sys.modules.

    ``relative_path`` is relative to the repository root. ``name`` defaults to the file
    name without its suffix, with hyphens as underscores.
    """
    path = ROOT / relative_path
    spec = importlib.util.spec_from_file_location(name or path.stem.replace("-", "_"), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

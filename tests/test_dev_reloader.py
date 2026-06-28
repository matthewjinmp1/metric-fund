import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import dev_reloader


class DevReloaderTests(unittest.TestCase):
    def test_watched_files_include_source_and_ignore_cache_dirs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "server.py").write_text("print('server')\n")
            public = root / "public"
            public.mkdir()
            (public / "script.js").write_text("console.log('app');\n")
            (public / "notes.txt").write_text("ignore me\n")
            cache = root / "__pycache__"
            cache.mkdir()
            (cache / "ignored.py").write_text("print('ignore')\n")

            with patch.object(dev_reloader, "ROOT", root):
                watched = {path.relative_to(root).as_posix() for path in dev_reloader.watched_files()}

        self.assertEqual(watched, {"server.py", "public/script.js"})


if __name__ == "__main__":
    unittest.main()

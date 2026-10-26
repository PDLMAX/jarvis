# -*- coding: utf-8 -*-
"""pytest 引导：把项目根目录加入 sys.path，便于 import config / app。"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

#!/usr/bin/env sh
python3 -m http.server "${PORT:-4173}" --bind 127.0.0.1

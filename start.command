#!/bin/sh
# Двойной клик запускает мост и открывает плеер в браузере.
cd "$(dirname "$0")" || exit 1
( sleep 1.2; open "http://127.0.0.1:8777" ) &
exec node server.mjs "$@"

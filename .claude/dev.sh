#!/bin/zsh
# Dev-server launcher: puts node on PATH (Turbopack spawns pooled `node`
# workers for PostCSS), then runs Next dev.
export PATH="/Users/brendonhome/.local/node/bin:$PATH"
exec node node_modules/next/dist/bin/next dev

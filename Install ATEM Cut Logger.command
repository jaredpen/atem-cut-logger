#!/bin/bash
# Double-click this in Finder to build ATEM Cut Logger.app and put it in Applications.
cd "$(dirname "$0")"
bash scripts/build-mac-app.sh

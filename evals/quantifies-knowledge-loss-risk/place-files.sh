#!/usr/bin/env bash
set -eu
cp -R "$(dirname "$0")/files/." .
sh ./build-metrics-repo.sh

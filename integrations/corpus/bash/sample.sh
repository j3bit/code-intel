#!/usr/bin/env bash

greet() {
  local name="${1:-world}"
  printf 'hello %s\n' "$name"
}

greet "$@"

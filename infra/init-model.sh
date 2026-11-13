#!/bin/sh
set -eu
revision=5617a9f61b028005a4858fdac845db406aefb181
base="https://huggingface.co/BAAI/bge-m3/resolve/$revision"
manifest=$(cd "$(dirname "$0")" && pwd)/bge-m3.sha256
target=/models/bge-m3
previous=/models/.bge-m3-previous
# 初始化程式是唯一可寫入模型卷的服務；避免同時修復同一個目錄。
exec 9>/models/.init-bge-m3.lock
flock 9
if [ ! -e "$target" ] && [ -d "$previous" ]; then mv -T "$previous" "$target"; fi
verify() { (cd "$1" && sha256sum --strict -c "$manifest"); }
if [ -r "$target/REVISION" ] && [ "$(cat "$target/REVISION")" = "$revision" ] && verify "$target" >/dev/null 2>&1; then
  echo "模型已就緒"
  exit 0
fi
stage=$(mktemp -d /models/.download-XXXXXX)
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/1_Pooling"
while read -r checksum file; do
  curl --fail --location --silent --show-error --retry 4 --output "$stage/$file" "$base/$file"
done < "$manifest"
verify "$stage"
printf '%s\n' "$revision" > "$stage/REVISION"
chmod -R a+rX "$stage"
# 全部檔案通過驗證後才輪替。中斷於兩次更名之間，下次可還原舊目錄。
rm -rf "$previous"
if [ -e "$target" ]; then mv -T "$target" "$previous"; fi
if ! mv -T "$stage" "$target"; then
  if [ -d "$previous" ]; then mv -T "$previous" "$target"; fi
  exit 1
fi
rm -rf "$previous"
echo "本機向量模型已下載並驗證"

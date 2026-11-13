#!/bin/sh
# 在無網路的容器與空白 tmpfs 中，以小型檔案驗證真正的 SHA-256 與輪替程式。
set -eu
mkdir -p /tmp/check/1_Pooling /tmp/init /tmp/bin
cp /source/init-model.sh /tmp/init/
cd /tmp/check
while read -r checksum file; do
  printf '測試模型 %s\n' "$file" > "$file"
  sha256sum "$file" >> /tmp/init/bge-m3.sha256
done < /source/bge-m3.sha256
cat >/tmp/bin/curl <<'MOCK'
#!/bin/sh
set -eu
while [ "$1" != --output ]; do shift; done
file=${3#*/resolve/*/}
case "$FETCH" in
  fail) exit 22 ;;
  corrupt) printf '損壞\n' >"$2" ;;
  good) cp "/tmp/check/$file" "$2" ;;
esac
MOCK
chmod +x /tmp/bin/curl
export PATH=/tmp/bin:$PATH
target=/models/bge-m3
revision=5617a9f61b028005a4858fdac845db406aefb181
mkdir "$target"
echo "$revision" > "$target/REVISION"
echo '不可遺失' > "$target/sentinel"
for mode in fail corrupt; do
  if FETCH=$mode sh /tmp/init/init-model.sh; then exit 1; fi
  test -f "$target/sentinel"
  test ! -e "$target/pytorch_model.bin"
done
# 正式校驗清單也必須拒絕測試用的偽造權重。
if FETCH=good sh /source/init-model.sh; then exit 1; fi
test -f "$target/sentinel"
FETCH=good sh /tmp/init/init-model.sh
test ! -e "$target/sentinel"
(cd "$target" && sha256sum -c /tmp/init/bge-m3.sha256)
mv "$target" /models/.bge-m3-previous
FETCH=fail sh /tmp/init/init-model.sh
test -s "$target/pytorch_model.bin"
printf '遭竄改' > "$target/tokenizer.json"
if FETCH=fail sh /tmp/init/init-model.sh; then exit 1; fi
test "$(cat "$target/tokenizer.json")" = '遭竄改'
FETCH=good sh /tmp/init/init-model.sh
cmp "$target/tokenizer.json" /tmp/check/tokenizer.json
echo '離線修復驗證通過'

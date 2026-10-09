#!/usr/bin/env bash
#
# 生成发布签名密钥并构建 release 签名 APK（TV 版 + 手机版）
#
# 用法：
#   ANDROID_HOME=/opt/android-sdk JAVA_HOME=/path/to/jdk bash sign-release.sh
#
# 自定义签名（可选，首次运行会自动生成一份默认密钥）：
#   STORE_PASS=xxx KEY_PASS=xxx KEY_ALIAS=tvwallpaper \
#   KEY_DN="CN=NAS Wallpaper, OU=Dev, O=Example, L=CN, ST=CN, C=CN" \
#   bash sign-release.sh
#
set -euo pipefail

cd "$(dirname "$0")"

# ---- 环境 ----
: "${ANDROID_HOME:=/opt/android-sdk}"
: "${JAVA_HOME:=/root/.sdkman/candidates/java/20.fx-zulu}"
export ANDROID_HOME JAVA_HOME
export PATH="$JAVA_HOME/bin:$PATH"

GRADLE_BIN="gradle"
if [ -x ./gradlew ]; then GRADLE_BIN="./gradlew"; fi

KS_FILE="release-keystore.jks"
PROPS="keystore.properties"

# ---- 1) 生成签名密钥（若不存在 keystore 配置）----
if [ ! -f "$PROPS" ]; then
  echo "==> 未找到 $PROPS，开始生成发布密钥（$KS_FILE）"
  STORE_PASS="${STORE_PASS:-android}"
  KEY_PASS="${KEY_PASS:-android}"
  KEY_ALIAS="${KEY_ALIAS:-tvwallpaper}"
  KEY_DN="${KEY_DN:-CN=NAS Wallpaper, OU=Dev, O=Example, L=CN, ST=CN, C=CN}"
  "$JAVA_HOME/bin/keytool" -genkeypair -v \
    -keystore "$KS_FILE" -alias "$KEY_ALIAS" \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$STORE_PASS" -keypass "$KEY_PASS" \
    -dname "$KEY_DN"
  cat > "$PROPS" <<EOF
storeFile=$KS_FILE
storePassword=$STORE_PASS
keyAlias=$KEY_ALIAS
keyPassword=$KEY_PASS
EOF
  echo "==> 已生成 $KS_FILE 与 $PROPS（请妥善保管，勿提交到版本库）"
fi

# ---- 2) 构建 release 签名 APK ----
echo "==> 构建 release 签名 APK（TV + 手机）"
"$GRADLE_BIN" assembleRelease --no-daemon

# ---- 3) 校验签名 ----
APKSIGNER="$ANDROID_HOME/build-tools/34.0.0/apksigner"
if [ -x "$APKSIGNER" ]; then
  echo "==> 校验签名"
  shopt -s nullglob
  for a in app/build/outputs/apk/release/*.apk app-phone/build/outputs/apk/release/*.apk; do
    echo "---- $a ----"
    "$APKSIGNER" verify --print-certs "$a" | sed -n '1,12p'
  done
else
  echo "!! 未找到 apksigner（$APKSIGNER），跳过签名校验"
fi

echo "完成。产物见："
echo "  app/build/outputs/apk/release/"
echo "  app-phone/build/outputs/apk/release/"

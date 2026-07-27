"""Platform secret storage adapters."""
import shutil
import subprocess
import sys

def dpapi_available() -> bool:
    """DPAPI 仅在 Windows 上可用。"""
    import ctypes

    return hasattr(ctypes, "windll")


def _dpapi_protect(data: bytes, protect: bool) -> bytes:
    import ctypes
    import ctypes.wintypes as wintypes

    class DataBlob(ctypes.Structure):
        _fields_ = [
            ("cbData", wintypes.DWORD),
            ("pbData", ctypes.POINTER(ctypes.c_char)),
        ]

    buffer_in = ctypes.create_string_buffer(data, len(data))
    blob_in = DataBlob(
        len(data),
        ctypes.cast(buffer_in, ctypes.POINTER(ctypes.c_char)),
    )
    blob_out = DataBlob()

    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32

    if protect:
        ok = crypt32.CryptProtectData(
            ctypes.byref(blob_in),
            None,
            None,
            None,
            None,
            0,
            ctypes.byref(blob_out),
        )
    else:
        ok = crypt32.CryptUnprotectData(
            ctypes.byref(blob_in),
            None,
            None,
            None,
            None,
            0,
            ctypes.byref(blob_out),
        )

    if not ok:
        raise RuntimeError("DPAPI 调用失败")

    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        kernel32.LocalFree(blob_out.pbData)


def dpapi_encrypt_text(plain_text: str) -> str:
    """加密文本，返回 base64 字符串（可安全写入 JSON 文件）。"""
    import base64

    encrypted = _dpapi_protect(plain_text.encode("utf-8"), True)
    return base64.b64encode(encrypted).decode("ascii")


def dpapi_decrypt_text(encrypted_b64: str) -> str:
    """解密 dpapi_encrypt_text 的产物。"""
    import base64

    encrypted = base64.b64decode(encrypted_b64)
    return _dpapi_protect(encrypted, False).decode("utf-8")


# ============================================================================
# 本地密钥存储抽象（Windows DPAPI / macOS Keychain / 其他平台禁用）
# ============================================================================

class SecretStore:
    """本地免密存储策略接口：只负责把一段文本安全地放到当前用户密钥库。"""

    label = "当前平台不可用"

    def available(self) -> bool:
        return False

    def encrypt_text(self, plain_text: str) -> str:
        raise RuntimeError("当前平台没有可用的本地密钥存储")

    def decrypt_text(self, encrypted: str) -> str:
        raise RuntimeError("当前平台没有可用的本地密钥存储")


class WindowsSecretStore(SecretStore):
    label = "Windows DPAPI"

    def available(self) -> bool:
        return dpapi_available()

    def encrypt_text(self, plain_text: str) -> str:
        return dpapi_encrypt_text(plain_text)

    def decrypt_text(self, encrypted: str) -> str:
        return dpapi_decrypt_text(encrypted)


class MacKeychainSecretStore(SecretStore):
    """
    使用 macOS 自带 security CLI 写入登录钥匙串。
    缓存文件里只保存 keychain:// 标记，真正的密码留在 Keychain。
    """

    label = "macOS Keychain"
    service = "ClaudeCodeNotify"
    account = "deploy-password"
    marker = "keychain://deploy-password"

    def available(self) -> bool:
        return (
            sys.platform == "darwin"
            and shutil.which("security") is not None
        )

    def encrypt_text(self, plain_text: str) -> str:
        if not self.available():
            raise RuntimeError("macOS Keychain 不可用")
        subprocess.run(
            [
                "security",
                "add-generic-password",
                "-U",
                "-s",
                self.service,
                "-a",
                self.account,
                "-w",
                plain_text,
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        return self.marker

    def decrypt_text(self, encrypted: str) -> str:
        if encrypted != self.marker:
            raise RuntimeError("不是 macOS Keychain 密文标记")
        result = subprocess.run(
            [
                "security",
                "find-generic-password",
                "-s",
                self.service,
                "-a",
                self.account,
                "-w",
            ],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        return result.stdout.rstrip("\n")


class NullSecretStore(SecretStore):
    pass


def create_secret_store() -> SecretStore:
    if sys.platform == "win32":
        return WindowsSecretStore()
    if sys.platform == "darwin":
        return MacKeychainSecretStore()
    return NullSecretStore()


SECRET_STORE = create_secret_store()

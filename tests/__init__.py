# Testlerde "ilk girişte şifre değiştir" zorunluluğu kapalı (ayrı testi tests/test_force_password.py açar)
import os

os.environ.setdefault("CAYMAZ_FORCE_PASSWORD_CHANGE", "0")

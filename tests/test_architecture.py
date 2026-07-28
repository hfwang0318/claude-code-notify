import ast
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
PACKAGE_ROOT = PROJECT_ROOT / "claude_code_notify"


def imports_in(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    imports: set[str] = set()
    package = path.relative_to(PROJECT_ROOT).with_suffix("").parts

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imports.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                prefix = list(package[:-1])
                if node.level > 1:
                    prefix = prefix[: -(node.level - 1)]
                module = ".".join(prefix + ([node.module] if node.module else []))
            else:
                module = node.module or ""
            imports.add(module)
    return imports


class ArchitectureBoundaryTests(unittest.TestCase):
    def python_files(self, area: str) -> list[Path]:
        return sorted((PACKAGE_ROOT / area).rglob("*.py"))

    def assert_no_import_prefixes(
        self,
        files: list[Path],
        forbidden: tuple[str, ...],
    ) -> None:
        violations: list[str] = []
        for path in files:
            for imported in imports_in(path):
                if imported.startswith(forbidden):
                    violations.append(
                        f"{path.relative_to(PROJECT_ROOT)} -> {imported}"
                    )
        self.assertEqual(violations, [], "\n".join(violations))

    def test_domain_is_framework_and_adapter_independent(self) -> None:
        self.assert_no_import_prefixes(
            self.python_files("domain"),
            (
                "PySide6",
                "claude_code_notify.application",
                "claude_code_notify.infrastructure",
                "claude_code_notify.presentation",
            ),
        )

    def test_application_does_not_depend_on_adapters_or_views(self) -> None:
        self.assert_no_import_prefixes(
            self.python_files("application"),
            (
                "PySide6",
                "claude_code_notify.infrastructure",
                "claude_code_notify.presentation",
            ),
        )

    def test_infrastructure_does_not_depend_on_views(self) -> None:
        self.assert_no_import_prefixes(
            self.python_files("infrastructure"),
            ("claude_code_notify.presentation",),
        )

    def test_presentation_has_no_platform_branches(self) -> None:
        forbidden_imports = {"os", "platform", "subprocess", "sys"}
        forbidden_tokens = (
            "sys.platform",
            "win32",
            "darwin",
            ".chmod(",
            '"setx"',
        )
        violations: list[str] = []
        for path in self.python_files("presentation"):
            imports = imports_in(path)
            for imported in sorted(imports & forbidden_imports):
                violations.append(
                    f"{path.relative_to(PROJECT_ROOT)} imports {imported}"
                )
            text = path.read_text(encoding="utf-8")
            for token in forbidden_tokens:
                if token in text:
                    violations.append(
                        f"{path.relative_to(PROJECT_ROOT)} contains {token}"
                    )
        self.assertEqual(violations, [], "\n".join(violations))

    def test_compatibility_entry_contains_no_business_classes(self) -> None:
        path = PROJECT_ROOT / "claude_notify_server.py"
        tree = ast.parse(path.read_text(encoding="utf-8"))
        classes = [
            node.name
            for node in tree.body
            if isinstance(node, ast.ClassDef)
        ]
        self.assertEqual(classes, ["_CompatibilityModule"])
        self.assertLess(len(path.read_text(encoding="utf-8").splitlines()), 100)

    def test_modules_remain_bounded(self) -> None:
        oversized = [
            f"{path.relative_to(PROJECT_ROOT)}: {len(path.read_text(encoding='utf-8').splitlines())}"
            for path in PACKAGE_ROOT.rglob("*.py")
            if len(path.read_text(encoding="utf-8").splitlines()) > 2000
        ]
        self.assertEqual(oversized, [], "\n".join(oversized))


if __name__ == "__main__":
    unittest.main()

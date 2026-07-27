import unittest

from claude_notify_server import (
    format_approval_type_counts,
    is_completed_approval_decision,
)


class ApprovalStatsTests(unittest.TestCase):
    def test_formats_all_tool_types_in_first_seen_order(self) -> None:
        counts = {
            "AskUserQuestion": 2,
            "Bash": 3,
        }

        self.assertEqual(
            format_approval_type_counts(counts),
            "AskUserQuestion x2，Bash x3",
        )

    def test_empty_counts_have_clear_placeholder(self) -> None:
        self.assertEqual(
            format_approval_type_counts({}),
            "暂无审批记录",
        )

    def test_only_gui_completed_decisions_are_counted(self) -> None:
        for decision in (
            "allow",
            "deny",
            "suggestion",
            "answer",
        ):
            with self.subTest(decision=decision):
                self.assertTrue(
                    is_completed_approval_decision(decision)
                )

        for decision in (
            "",
            "ask",
            "dismissed",
            "timeout",
            "cancelled",
        ):
            with self.subTest(decision=decision):
                self.assertFalse(
                    is_completed_approval_decision(decision)
                )


if __name__ == "__main__":
    unittest.main()

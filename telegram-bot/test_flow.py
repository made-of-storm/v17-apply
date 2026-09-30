"""Regression tests for bot step machine — no Telegram needed."""

from __future__ import annotations

import os
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

for name in (
    "telegram",
    "telegram.constants",
    "telegram.ext",
    "httpx",
):
    sys.modules.setdefault(name, MagicMock())

import bot


def gate(**kwargs):
    base = {
        "segment": ["b2c"],
        "stage": "seed",
        "mrr": 20000,
        "market": ["global"],
    }
    base.update(kwargs)
    return base


class FakeQuery:
    def __init__(self, data):
        self.data = data
        self.answers = []
        self.message = SimpleNamespace(reply_text=AsyncMock())

    async def answer(self, text=None, **kwargs):
        self.answers.append((text, kwargs))


def callback_update(data):
    query = FakeQuery(data)
    return SimpleNamespace(callback_query=query, effective_message=query.message), query


def text_update(text):
    msg = SimpleNamespace(text=text, reply_text=AsyncMock())
    return SimpleNamespace(
        message=msg,
        callback_query=None,
        effective_message=msg,
    )


def context():
    return SimpleNamespace(user_data={})


class ParseMoney(unittest.TestCase):
    def test_formats(self):
        self.assertEqual(bot.parse_money("35k"), 35000)
        self.assertEqual(bot.parse_money("$35,000"), 35000)
        self.assertEqual(bot.parse_money("35 000"), 35000)
        self.assertEqual(bot.parse_money("1.2m"), 1_200_000)
        self.assertIsNone(bot.parse_money(""))
        self.assertIsNone(bot.parse_money("Seed"))
        self.assertIsNone(bot.parse_money("Series A"))


class Gate(unittest.TestCase):
    def test_missing_mrr_is_not_zero(self):
        ans = {"segment": ["b2c"], "stage": "seed"}
        self.assertEqual(bot.gate_incomplete_step(ans), "mrr")
        self.assertEqual(bot.mrr_verdict(ans), "incomplete")

    def test_elena_bug_stage_does_not_jump_to_gate(self):
        ans = {"segment": ["b2c"], "stage": "seed"}
        self.assertEqual(bot.next_step("segment", ans), "stage")
        self.assertEqual(bot.next_step("stage", ans), "mrr")
        self.assertNotEqual(bot.next_step("stage", ans), "gate")

    def test_cannot_reach_gate_without_mrr(self):
        ans = {"segment": ["b2b"], "stage": "seriesa", "market": ["usa"]}
        self.assertEqual(bot.next_step("market", ans), "mrr")
        self.assertEqual(bot.mrr_verdict(ans), "incomplete")

    def test_cannot_reach_gate_without_market(self):
        ans = {"segment": ["b2c"], "stage": "seed", "mrr": 20000}
        self.assertEqual(bot.next_step("mrr", ans), "market")
        self.assertEqual(bot.gate_incomplete_step(ans), "market")

    def test_other_market_asks_followup(self):
        ans = gate(market=["other"])
        self.assertEqual(bot.next_step("market", ans), "market_other")
        self.assertEqual(bot.gate_incomplete_step(ans), "market_other")
        ans["market_other"] = "India"
        self.assertEqual(bot.next_step("market_other", ans), "gate")
        self.assertIsNone(bot.gate_incomplete_step(ans))

    def test_global_skips_other(self):
        ans = gate()
        self.assertEqual(bot.next_step("market", ans), "gate")

    def test_b2c_thresholds(self):
        self.assertEqual(bot.mrr_verdict(gate(mrr=4000)), "hard")
        self.assertEqual(bot.mrr_verdict(gate(mrr=7000)), "soft")
        self.assertEqual(bot.mrr_verdict(gate(mrr=10000)), "pass")

    def test_b2b_thresholds(self):
        ans = gate(segment=["b2b"], mrr=20000)
        self.assertEqual(bot.mrr_verdict(ans), "soft")
        ans["mrr"] = 10000
        self.assertEqual(bot.mrr_verdict(ans), "hard")
        ans["mrr"] = 30000
        self.assertEqual(bot.mrr_verdict(ans), "pass")

    def test_b2b2c_uses_strict_threshold(self):
        ans = gate(segment=["b2b2c"], mrr=12000)
        self.assertEqual(bot.mrr_verdict(ans), "hard")

    def test_typed_zero_is_hard_not_incomplete(self):
        self.assertEqual(bot.mrr_verdict(gate(mrr=0)), "hard")

    def test_zero_without_other_answers_is_incomplete(self):
        self.assertEqual(bot.mrr_verdict({"mrr": 0}), "incomplete")


class ApplicationPath(unittest.TestCase):
    def test_cohort_skips_raise_fields(self):
        ans = gate(interested_in=["cohort"])
        self.assertEqual(bot.next_step("interested_in", ans), "verticals")
        self.assertTrue(bot.skip_step("amount_raising", ans))
        self.assertTrue(bot.skip_step("post_money", ans))

    def test_investment_asks_raise_fields(self):
        ans = gate(interested_in=["investment"])
        self.assertEqual(bot.next_step("interested_in", ans), "amount_raising")
        self.assertEqual(bot.next_step("amount_raising", ans), "post_money")
        self.assertEqual(bot.next_step("post_money", ans), "verticals")

    def test_media_asks_raise_fields(self):
        ans = gate(interested_in=["media"])
        self.assertFalse(bot.skip_step("amount_raising", ans))

    def test_other_vertical_followup(self):
        ans = gate(verticals=["FinTech"])
        self.assertTrue(bot.skip_step("verticals_other", ans))
        ans["verticals"] = ["Other"]
        self.assertFalse(bot.skip_step("verticals_other", ans))
        self.assertEqual(bot.next_step("verticals", ans), "verticals_other")

    def test_hidden_answers_are_removed_when_choice_changes(self):
        ans = {
            "market": ["global"],
            "market_other": "India",
            "verticals": ["FinTech"],
            "verticals_other": "SpaceTech",
            "interested_in": ["cohort"],
            "amount_raising": 500000,
            "post_money": 7000000,
        }
        bot.normalize_dependencies("market", ans)
        bot.normalize_dependencies("verticals", ans)
        bot.normalize_dependencies("interested_in", ans)
        self.assertNotIn("market_other", ans)
        self.assertNotIn("verticals_other", ans)
        self.assertNotIn("amount_raising", ans)
        self.assertNotIn("post_money", ans)

    def test_other_answers_remain_while_other_is_selected(self):
        ans = {
            "market": ["other"],
            "market_other": "India",
            "verticals": ["Other"],
            "verticals_other": "SpaceTech",
        }
        bot.normalize_dependencies("market", ans)
        bot.normalize_dependencies("verticals", ans)
        self.assertEqual(ans["market_other"], "India")
        self.assertEqual(ans["verticals_other"], "SpaceTech")

    def test_resume_does_not_use_welcome_when_answers_exist(self):
        ans = {"segment": ["b2c"], "stage": "seed"}
        self.assertEqual(bot.resume_step(ans, "welcome"), "mrr")
        self.assertEqual(bot.resume_step(ans, "thesis"), "mrr")

    def test_resume_hard_fail_without_mrr_asks_mrr(self):
        ans = {"segment": ["b2c"], "stage": "seed"}
        self.assertEqual(bot.resume_step(ans, "hard_fail"), "mrr")
        self.assertEqual(bot.resume_step(ans, "gate"), "mrr")

    def test_resume_hard_fail_with_mrr_goes_to_gate(self):
        ans = gate(mrr=1000)
        self.assertEqual(bot.resume_step(ans, "hard_fail"), "gate")

    def test_resume_keeps_real_step(self):
        ans = gate(company_name="Acme")
        self.assertEqual(bot.resume_step(ans, "website"), "website")

    def test_infer_low_mrr_goes_to_gate_not_hard_fail(self):
        self.assertEqual(bot.infer_step(gate(mrr=1000)), "gate")

    def test_infer_gate_when_filter_done(self):
        self.assertEqual(bot.infer_step(gate()), "gate")

    def test_submit_rejects_incomplete(self):
        self.assertEqual(bot.submit_missing(gate()), "company_name")
        self.assertEqual(bot.submit_missing({"company_name": "X"}), "segment")

    def test_submit_hard_mrr_is_not_blocked(self):
        ans = gate(mrr=1000, company_name="X", contact_email="a@co.com")
        self.assertEqual(bot.submit_missing(ans), "website")

    def test_complete_cohort_application_can_submit(self):
        ans = gate(
            company_name="Acme",
            website="https://acme.test",
            interested_in=["cohort"],
            verticals=["FinTech"],
            problem="A real problem",
            pitch_deck="https://acme.test/deck",
            icp="Businesses",
            team="Two founders",
            ret30=40,
            ret60=25,
            ret90=18,
            cac=40,
            ltv=180,
            payback="Six months",
            sub_model="Subscription",
            organic_pct=20,
            mrr_growth="$20k, 10% per month",
            marketing_spend=5000,
            contact_name="Alex",
            contact_email="alex@acme.test",
        )
        self.assertIsNone(bot.submit_missing(ans))


class Email(unittest.TestCase):
    def test_free_inbox_rejected(self):
        self.assertIsNotNone(bot.validate_email("founder@gmail.com"))
        self.assertIsNone(bot.validate_email("founder@startup.io"))


class BackendResponse(unittest.TestCase):
    def test_success_response_is_accepted(self):
        result = {"ok": True, "telegram_notified": True}
        self.assertIs(bot.validate_submit_result(result), result)

    def test_http_200_error_response_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "sheet failed"):
            bot.validate_submit_result({"ok": False, "error": "sheet failed"})

    def test_non_json_shape_is_rejected(self):
        with self.assertRaises(RuntimeError):
            bot.validate_submit_result(None)


class HandlerFlow(unittest.IsolatedAsyncioTestCase):
    async def test_segment_stage_mrr_market_order(self):
        ctx = context()
        bot.data(ctx)["step"] = "segment"
        with patch.object(bot, "send", new=AsyncMock()):
            update, _ = callback_update("t:segment:b2c")
            await bot.on_callback(update, ctx)
            self.assertEqual(bot.data(ctx)["step"], "stage")

            update, _ = callback_update("s:stage:seed")
            await bot.on_callback(update, ctx)
            self.assertEqual(bot.data(ctx)["step"], "mrr")
            self.assertNotIn("mrr", bot.answers(ctx))

            await bot.on_text(text_update("15 000"), ctx)
            self.assertEqual(bot.data(ctx)["step"], "market")
            self.assertEqual(bot.answers(ctx)["mrr"], 15000)

    async def test_market_other_opens_text_field(self):
        ctx = context()
        store = bot.data(ctx)
        store["step"] = "market"
        store["answers"].update(segment=["b2c"], stage="seed", mrr=15000)
        with patch.object(bot, "send", new=AsyncMock()), patch.object(
            bot, "send_text_question", new=AsyncMock()
        ):
            update, query = callback_update("t:market:other")
            await bot.on_callback(update, ctx)
            self.assertEqual(store["step"], "market_other")
            self.assertIn("other", store["answers"]["market"])
            self.assertIn("Other selected", query.answers[-1][0])

            await bot.on_text(text_update("India"), ctx)
            self.assertEqual(store["step"], "company_name")
            self.assertEqual(store["answers"]["market_other"], "India")

    async def test_other_vertical_opens_text_field(self):
        ctx = context()
        store = bot.data(ctx)
        store["step"] = "verticals"
        store["answers"].update(gate(company_name="Acme", website="https://acme.test", interested_in=["cohort"]))
        with patch.object(bot, "send", new=AsyncMock()), patch.object(
            bot, "send_text_question", new=AsyncMock()
        ):
            update, _ = callback_update("t:verticals:Other")
            await bot.on_callback(update, ctx)
            self.assertEqual(store["step"], "verticals_other")
            self.assertIn("Other", store["answers"]["verticals"])

    async def test_soft_gate_continues_only_after_confirmation(self):
        ctx = context()
        store = bot.data(ctx)
        store["step"] = "market"
        store["answers"].update(segment=["b2c"], stage="seed", mrr=7000)
        with patch.object(bot, "send", new=AsyncMock()) as send:
            update, _ = callback_update("t:market:global")
            await bot.on_callback(update, ctx)
            update, _ = callback_update("n:market")
            await bot.on_callback(update, ctx)
            self.assertEqual(store["step"], "gate")
            self.assertTrue(store["answers"]["below_soft_threshold"])
            self.assertIn("Not yet", send.call_args[0][1])

            update, _ = callback_update("nav:continue")
            await bot.on_callback(update, ctx)
            self.assertEqual(store["step"], "company_name")

    async def test_hard_gate_offers_continue_not_dead_end(self):
        ctx = context()
        store = bot.data(ctx)
        store["step"] = "market"
        store["answers"].update(segment=["b2c"], stage="seed", mrr=1000)
        with patch.object(bot, "send", new=AsyncMock()) as send:
            update, _ = callback_update("t:market:global")
            await bot.on_callback(update, ctx)
            update, _ = callback_update("n:market")
            await bot.on_callback(update, ctx)
            self.assertEqual(store["step"], "gate")
            self.assertTrue(store["answers"]["below_soft_threshold"])
            self.assertIn("Not yet", send.call_args[0][1])
            self.assertNotIn("below threshold", send.call_args[0][1].lower())

            update, _ = callback_update("nav:continue")
            await bot.on_callback(update, ctx)
            self.assertEqual(store["step"], "company_name")

    async def test_stale_stage_button_cannot_rewind_application(self):
        ctx = context()
        store = bot.data(ctx)
        store["step"] = "company_name"
        store["answers"].update(segment=["b2c"], stage="seed", mrr=15000, market=["global"])
        with patch.object(bot, "send", new=AsyncMock()):
            update, _ = callback_update("s:stage:seriesa")
            await bot.on_callback(update, ctx)
        self.assertEqual(store["step"], "company_name")
        self.assertEqual(store["answers"]["stage"], "seed")

    async def test_start_resumes_unfinished_application(self):
        ctx = context()
        store = bot.data(ctx)
        store["step"] = "company_name"
        store["answers"].update(gate())
        with patch.object(bot, "send", new=AsyncMock()) as send:
            await bot.cmd_start(text_update("/start"), ctx)
        self.assertEqual(store["step"], "company_name")
        self.assertEqual(store["answers"]["stage"], "seed")
        self.assertIn("unfinished application", send.call_args[0][1])

    async def test_start_without_progress_shows_welcome(self):
        ctx = context()
        with patch.object(bot, "ask", new=AsyncMock()) as ask:
            await bot.cmd_start(text_update("/start"), ctx)
        self.assertEqual(bot.data(ctx)["step"], "welcome")
        ask.assert_awaited()

    async def test_company_name_prompt_says_to_type(self):
        ctx = context()
        with patch.object(bot, "send_text_question", new=AsyncMock()) as send_q:
            await bot.ask_company_name(text_update("x"), ctx, {}, {})
        self.assertIn("Type your company name", send_q.call_args[0][1])


class ClientCopy(unittest.TestCase):
    def test_submitted_mentions_email_and_thanks(self):
        self.assertIn("We will look at it", bot.SUBMITTED)
        self.assertIn("over email", bot.SUBMITTED)
        self.assertIn("Thank you!", bot.SUBMITTED)
        self.assertNotIn("look at the numbers", bot.SUBMITTED)

    def test_not_yet_offer_has_no_threshold_dollars(self):
        self.assertIn("Not yet", bot.NOT_YET_OFFER)
        self.assertIn("marketing or analytics", bot.NOT_YET_OFFER)
        self.assertNotIn("$", bot.NOT_YET_OFFER)
        self.assertNotIn("PASS", bot.NOT_YET_OFFER)
        self.assertNotIn("FAIL", bot.NOT_YET_OFFER)
        self.assertNotIn("$10k", bot.THESIS)
        self.assertNotIn("$30k", bot.THESIS)


class SessionHelpers(unittest.TestCase):
    def test_has_in_progress(self):
        self.assertFalse(bot.has_in_progress({"answers": {}, "step": "welcome"}))
        self.assertTrue(bot.has_in_progress({"answers": {"mrr": 1}, "step": "welcome"}))
        self.assertTrue(bot.has_in_progress({"answers": {}, "step": "company_name"}))

    def test_persistence_path_uses_data_dir(self):
        with patch.dict(os.environ, {"DATA_DIR": "/tmp/v17-bot-test"}):
            path = bot.persistence_path()
        self.assertTrue(path.endswith("bot_data.pickle"))
        self.assertIn("v17-bot-test", path)


if __name__ == "__main__":
    unittest.main()

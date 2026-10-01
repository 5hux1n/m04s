import asyncio
import random
import unittest
from pathlib import Path

from m04s_codec import MiniLZO, WIDTH_BYTES
from m04s_corebluetooth import HostGate
from m04s_driver import Completion, CreditWindow

ROOT = Path(__file__).resolve().parents[1]
def quiet(*args, **kwargs):
    pass


class CodecTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.codec = MiniLZO()

    def test_official_sample_rebuild_is_identical(self):
        original = (ROOT / 'samples/m04_printtask_1.bin').read_bytes()
        task = self.codec.parse(original)
        self.assertEqual(self.codec.build(task.raw, task.height).data, original)

    def test_multiblock_roundtrip_including_partial_block(self):
        raw = random.Random(4).randbytes(WIDTH_BYTES * 131)
        self.assertEqual(self.codec.build(raw, 131).raw, raw)

    def test_corrupt_or_truncated_input_is_rejected(self):
        task = self.codec.build(bytes(WIDTH_BYTES * 131), 131).data
        for data in (task[:-1], task[:9] + task[10:], task[:8] + b'\xff\xff' + task[10:]):
            with self.subTest(size=len(data)), self.assertRaises(ValueError):
                self.codec.parse(data)

    def test_image_matches_verified_baseline(self):
        task = self.codec.image(ROOT / 'samples/66.png')
        self.assertEqual(task.data, (ROOT / 'samples/m04_last_printtask.bin').read_bytes())

    def test_paper_widths_roundtrip_without_changing_rows(self):
        for width in (568,848,1248):
            raw=random.Random(width).randbytes(width//8*103)
            task=self.codec.build(raw,103,width=width)
            self.assertEqual(task.width,width)
            self.assertEqual(task.height,103)
            self.assertEqual(self.codec.parse(task.data).raw,raw)
        for width in (0,569,1256):
            with self.assertRaises(ValueError):self.codec.build(b'',1,width=width)


class FlowTests(unittest.IsolatedAsyncioTestCase):
    async def test_host_waits_for_ready_and_checks_property_again(self):
        ready = False
        gate = HostGate(lambda: ready, lambda: True, quiet, .1)
        pending = asyncio.create_task(gate.wait())
        await asyncio.sleep(0)
        self.assertFalse(pending.done())
        gate.ready()  # A callback alone must not permit a write.
        await asyncio.sleep(.001)
        self.assertFalse(pending.done())
        ready = True
        gate.ready()
        await pending
        self.assertGreater(gate.waits, 0)

    async def test_host_property_change_between_check_and_wait_is_not_lost(self):
        readings = iter((False, True, True))
        gate = HostGate(lambda: next(readings), lambda: True, quiet, .1)
        await gate.wait()
        self.assertEqual(gate.waits, 0)

    async def test_disconnect_wakes_host_and_credit_waiters(self):
        connected = True
        gate = HostGate(lambda: False, lambda: connected, quiet, .1)
        credit = CreditWindow(quiet, .1)
        credit.notify(b'\x01\x07')
        credit.notify(b'\x02\xf4\x00')
        for _ in range(7):
            credit.reserve()
        tasks = [asyncio.create_task(gate.wait()), asyncio.create_task(credit.wait_until(lambda: credit.available > 0))]
        await asyncio.sleep(0)
        connected = False
        gate.ready()
        credit.fail('disconnect')
        results = await asyncio.gather(*tasks, return_exceptions=True)
        self.assertTrue(all(isinstance(result, ConnectionError) for result in results))

    async def test_batched_returns_and_notification_during_write(self):
        credit = CreditWindow(quiet, .1)
        credit.notify(b'\x02\xf4\x00')
        credit.notify(b'\x01\x07')
        await credit.initialize()
        self.assertEqual(credit.packet_size, 182)
        for _ in range(7):
            credit.reserve()
        pending = asyncio.create_task(credit.wait_until(lambda: credit.available > 0))
        await asyncio.sleep(0)
        self.assertFalse(pending.done())
        credit.notify(b'\x01\x03')
        await pending
        credit.reserve()  # Reserve BEFORE an immediate acknowledgement.
        credit.notify(b'\x01\x01')
        self.assertEqual(credit.available, 3)
        credit.notify(b'\x01\x04')
        await credit.wait_until(lambda: credit.available == credit.capacity)
        self.assertEqual(credit.overflow, 0)

    async def test_credit_stall_has_finite_timeout(self):
        credit = CreditWindow(quiet, .01)
        with self.assertRaises(TimeoutError):
            await credit.wait_until(lambda: credit.available > 0)

    async def test_fragmented_finish_before_wait_is_retained(self):
        completion = Completion(quiet)
        completion.arm(100)
        completion.sent_bytes = 100
        completion.notify(b'unknown\x1a')
        completion.notify(b'\x0f')
        completion.notify(b'\x0c')
        await completion.wait(.01)
        self.assertIsNotNone(completion.received_at)

    async def test_idle_and_other_statuses_do_not_finish_next_job(self):
        completion = Completion(quiet)
        completion.notify(b'\x1a\x0f\x0c')
        completion.arm(100)
        completion.sent_bytes = 100
        completion.notify(b'\x1a\x0f\x01')
        with self.assertRaises(TimeoutError):
            await completion.wait(.01)

    async def test_premature_finish_rejects_truncated_job(self):
        completion = Completion(quiet)
        completion.arm(100)
        completion.sent_bytes = 99
        completion.notify(b'\x1a\x0f\x0c')
        with self.assertRaises(ConnectionError):
            await completion.wait(.01)


if __name__ == '__main__':
    unittest.main()

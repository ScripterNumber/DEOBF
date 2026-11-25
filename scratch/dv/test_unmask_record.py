import unittest
from unmask_record import unmask


class UnmaskRecordTest(unittest.TestCase):
    def test_word_and_tail(self):
        self.assertEqual(unmask(bytes(5), 0, 0).hex(), '030ac52457')
        self.assertEqual(unmask(bytes.fromhex('ff10203040'), 186, 0).hex(), '46a05faead')

    def test_bad_seeds(self):
        for seed, index in [(-1, 0), (256, 0), (0, -1), (0, 256)]:
            with self.subTest(seed=seed, index=index), self.assertRaises(ValueError):
                unmask(b'', seed, index)


if __name__ == '__main__':
    unittest.main()

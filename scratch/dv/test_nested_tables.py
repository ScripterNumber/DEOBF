import unittest
from nested_tables import extract


class NestedTableTest(unittest.TestCase):
    def test_layout_and_tail(self):
        data = bytes(14) + bytes.fromhex('03a485380100a485380204a4853803a48538048149ff76')
        result = extract(data)
        self.assertEqual(result['prefixes'], [3, 0, 4])
        self.assertEqual(result['arrays'], {'G': [1], 'B': [2], 'g': [3], 'p': [4]})
        self.assertEqual((result['mode'], result['slot']), (201, 16374))

    def test_short_and_invalid_counts(self):
        for data in (b'', bytes(14) + bytes.fromhex('0301')):
            with self.assertRaises(ValueError):
                extract(data)


if __name__ == '__main__':
    unittest.main()

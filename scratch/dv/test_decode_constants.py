import unittest
from decode_constants import decode


class ConstantDecodeTest(unittest.TestCase):
    def test_string_with_word_and_tail(self):
        result = decode(bytes.fromhex('71057ce0eae3af'), [0], 1)
        self.assertEqual(result['utf8'], 'hello')

    def test_signed_integer_and_byte(self):
        self.assertEqual(decode(bytes.fromhex('46c8a50e27'), [0], 1)['value'], 0x12345678)
        self.assertEqual(decode(bytes.fromhex('edce02414d'), [0] * 764, 764)['value'], 2634154227)
        self.assertEqual(decode(bytes.fromhex('f267'), [0], 1)['value'], 7)

    def test_upvalue_capture_triples(self):
        result = decode(bytes.fromhex('aa050b998437c6'), [0] * 472, 472)
        self.assertEqual(result['hex'], '0283678363')
        self.assertEqual(result['captures'], [[3, 9644, 121], [3, 9644, 120]])

    def test_rejects_unknown_tags_and_short_records(self):
        for data in (bytes.fromhex('00'), bytes.fromhex('710361'), bytes.fromhex('4601'), bytes.fromhex('f2')):
            with self.assertRaises(ValueError):
                decode(data, [0], 1)


if __name__ == '__main__':
    unittest.main()

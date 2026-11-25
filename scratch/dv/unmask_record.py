#!/usr/bin/env python3
"""Apply the statically derived mw record transform to bytes, without running Lua."""
import argparse
import hashlib
import json
from pathlib import Path


def unmask(data: bytes, seed: int, index: int) -> bytes:
    if not 0 <= seed <= 255 or not 0 <= index <= 255:
        raise ValueError('seed and index must be bytes')
    out = bytearray()
    word_end = len(data) - len(data) % 4
    for offset in range(0, word_end, 4):
        stream = []
        for _ in range(4):
            index = (173 * index + 3) % 256
            stream.append(index)
        mask = int.from_bytes(bytes(stream), 'little')
        word = int.from_bytes(data[offset:offset + 4], 'little') ^ mask ^ (seed * 0x01010101)
        out.extend(word.to_bytes(4, 'little'))
    for byte in data[word_end:]:
        index = (173 * index + 3) % 256
        out.append(byte ^ index ^ seed)
    return bytes(out)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('buffer', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--offset', type=int, required=True)
    parser.add_argument('--length', type=int, required=True)
    parser.add_argument('--seed', type=int, required=True)
    parser.add_argument('--index', type=int, required=True)
    args = parser.parse_args()
    original = args.buffer.read_bytes()
    if args.offset < 0 or args.length < 0 or args.offset + args.length > len(original):
        raise ValueError('slice is outside the input buffer')
    result = unmask(original[args.offset:args.offset + args.length], args.seed, args.index)
    args.output.write_bytes(result)
    print(json.dumps({'_provenance': {'generator': 'CodeRabbit', 'version': 1},
                      'input_sha256': hashlib.sha256(original).hexdigest(),
                      'offset': args.offset, 'length': args.length,
                      'seed': args.seed, 'index': args.index,
                      'output_sha256': hashlib.sha256(result).hexdigest()}, indent=2))

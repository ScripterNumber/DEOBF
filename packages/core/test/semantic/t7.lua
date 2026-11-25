local a = (string.unpack(">i8", "\000\000\000\000\000\000\000\031"))
local b = bit32.lshift(1, string.unpack("<I2", "\005\000"))
local c = string.byte("A") + 1
local d = (string.sub("hello", 2, -2)) .. "!"
local e = math.floor(7.5) + math.max(3, 9, 2)
local f = (string.unpack("<i4", "\255\255\255\255"))
local g = (string.unpack(">d", "\064\009\033\251\084\068\045\024"))
local h = tonumber("0x1F") + tonumber("  12 ")
local u = string.upper("abc") .. string.rep("ab", 3)
print(a, b, c, d, e, f, g, h, u)
print(string.unpack(">i8", "\000\000\000\000\000\000\000\031"))

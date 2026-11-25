local IlIlI = string.byte
local lIIlI = string.char
local IIlll = bit32 and bit32.bxor or function(a, b) local r, p = 0, 1 while a > 0 or b > 0 do local x, y = a % 2, b % 2 if x ~= y then r = r + p end a, b, p = (a - x) / 2, (b - y) / 2, p * 2 end return r end
local K = 0x2A
local unused1 = 12345
local unused2 = { 1, 2, 3 }
local function junk() return 1 end
local function dec(s, k)
  local out = {}
  for i = 1, #s do
    local c = IlIlI(s, i)
    out[#out + 1] = lIIlI(IIlll(c, k))
  end
  return table.concat(out)
end
local enc = {}
local msg = "Hello, PRISM!"
for i = 1, #msg do enc[i] = string.char(bit32.bxor(msg:byte(i), K)) end
local blob = table.concat(enc)
print(dec(blob, K))
local x = 5
local y = x * 2 + (3 - 1)
if 1 + 1 == 2 then print("opaque ok", y) else print("never") end
local t = setmetatable({}, { __index = function(_, k) return k .. "!" end })
print(t.abc, t["d" .. "e"])
local a, b, c = (function() return 1, 2, 3 end)()
print(a, b, c, select("#", (function() return 1, 2 end)()))
local acc = 0
for k = 10, 1, -3 do acc = acc + k end
print("acc", acc)
local s = 0
local i = 0
repeat local z = i * 2; s = s + z; i = i + 1 until z > 10
print("rep", s, i)
do local q = 7; local function r(n) if n <= 1 then return 1 end return n * r(n - 1) end print(r(q)) end
local co = coroutine.wrap(function(...) local n = select("#", ...) coroutine.yield(n) return "done" end)
print(co(1, 2, 3), co())
local str = "a\0b\1" .. "2\255"
print(#str, str:byte(1, -1))
print(("x"):rep(3), ("%d-%s"):format(5, "z"))
local function multi() return 1, nil, 3 end
local m = { multi() }
print(#m >= 1, m[3])
local g = 0
local function inc() g = g + 1 return g end
inc(); inc()
print("g", g)
local A = { 5, 4, 3 }
table.sort(A)
print(table.concat(A, ","))
print(math.floor(7.9), 7 // 2, 7 % 3, -7 % 3, 2 ^ 10, 10 / 4)
print(string.format("%q", "q\n\"x\""))
local u = "\u{48}\u{49}"
print(u, `interp {u} {1+2}`)

-- decoder-style code: base64 (custom alphabet), xor, LCG, bit32, closures, varargs
local alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
local map = {}
for i = 1, #alphabet do map[alphabet:sub(i, i)] = i - 1 end
local function b64(s)
  local out, bits, n = {}, 0, 0
  for i = 1, #s do
    local c = s:sub(i, i)
    local v = map[c]
    if v then
      bits = bits * 64 + v; n = n + 6
      if n >= 8 then
        n = n - 8
        local b = math.floor(bits / 2 ^ n) % 256
        out[#out + 1] = string.char(b)
      end
    end
  end
  return table.concat(out)
end
print(b64("SGVsbG8sIHdvcmxkIQ=="))
local function xorstr(s, key)
  local r = {}
  for i = 1, #s do
    local k = key:byte((i - 1) % #key + 1)
    r[i] = string.char(bit32.bxor(s:byte(i), k))
  end
  return table.concat(r)
end
local enc = xorstr("secret message", "k3y")
print(#enc, xorstr(enc, "k3y"))
local seed = 12345
local function rnd()
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed
end
print(rnd(), rnd(), rnd())
local function multi(...)
  local n = select("#", ...)
  return n, ...
end
print(multi(1, nil, 3))
local a, b, c = multi("x", "y")
print(a, b, c)
local t = { multi(7, 8) }
print(#t, t[1], t[3])
local ok, err = pcall(function() error("bad thing") end)
print(ok, type(err))
print(string.format("%d %5.1f %s %x %%", 42, 3.14159, "str", 255))
print(("hello world"):gsub("o", "0"))
print(("k1=v1;k2=v2"):match("(%w+)=(%w+)"))
for k, v in string.gmatch("a=1, b=2", "(%w+)=(%w+)") do print(k, v) end
local counter = 0
local function inc() counter = counter + 1; return counter end
inc(); inc()
print(counter, 7 // 2, 7 % 3, -7 % 3, 2 ^ 10, 10 / 4)
local x = 0
print(x and "zero-is-truthy" or "falsy", nil and 1 or 2, false or nil)
local s = 0
for i = 10, 1, -3 do s = s + i end
print(s)
local arr = {}
for i = 1, 5 do table.insert(arr, i * i) end
table.insert(arr, 1, 0)
print(table.concat(arr, ","), table.remove(arr), #arr)
local keys = {}
for k in pairs({ q = 1 }) do keys[#keys + 1] = k end
print(keys[1], tostring(nil), tostring(true), tonumber("0x1F"), tonumber("z", 36))
local str = "\1\2\3\255"
print(str:byte(1, -1))
print(#"\u{48}\u{49}", ("abc"):rep(2, "-"), ("Hello"):upper(), ("Hello"):lower())
local mt = setmetatable({}, { __index = function(_, k) return k .. "!" end })
print(mt.foo, rawget(mt, "foo"))

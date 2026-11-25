local t = {x = 1, y = {z = 5}}
local function f(a) return a * 2 end
local function g()
  local a, b, c
  a = t.y
  b = a.z
  c = f(b)
  a = 3
  print(c, a)
  local q = t.x
  t.x = 10
  print(q, t.x)
  local r = t.x
  local r2 = r + 1
  r = 7
  print(r2, r)
  local s = t.x
  if s > 5 then print("big", s) end
  local m = 4
  for i = 1, m do print(i) end print()
  return b
end
print(g())

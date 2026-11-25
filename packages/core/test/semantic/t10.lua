-- constFlow / unroll stress: reassigned locals, copies, shadowing, loops, closures
local out = {}
local function emit(...) local t = table.pack(...) for i = 1, t.n do out[#out + 1] = tostring(t[i]) end end
local a = 1
local b = a
a = 2
emit(a, b)                      -- 2 1
local t = {}
local r = t
r[1] = "x"
t = { "y" }
emit(r[1], t[1])                -- x y
local x = 5
if #out > 2 then x = 6 else x = 7 end
emit(x)                         -- 6
local y = 3
for i = 1, 3 do
  emit(y)                       -- 3, 4, 5
  y = y + 1
end
emit(y)
local z = 10
while z > 7 do z = z - 1 emit(z) end
local w = 1
repeat local q = w * 2; w = w + 1 until q >= 6
emit(w)                         -- 4
local s = "s"
do local s = "inner"; emit(s) end
emit(s)
local c = 1
local f = function() return c end
c = 2
emit(f())                       -- 2
local u = 1
local g = function() u = u + 10 end
g()
emit(u)                         -- 11
local p, q2 = 1, 2
p, q2 = q2, p
emit(p, q2)                     -- 2 1
local m = 1
local m2 = m
local m = 3                     -- shadow
emit(m, m2)                     -- 3 1
local acc = 0
for k = 1, 4 do local kk = k * k; acc = acc + kk end
emit(acc)                       -- 30
local fs = {}
for k = 1, 3 do fs[k] = function() return k end end
emit(fs[1](), fs[2](), fs[3]())  -- 1 2 3
for k = 3, 1, -1 do emit(k) end
for k = 1, 0 do emit("never") end
local brk = 0
for k = 1, 5 do if k == 3 then break end brk = k end
emit(brk)                       -- 2
local function ret(n) for k = 1, 3 do if k == n then return k * 100 end end return -1 end
emit(ret(2), ret(7))
local v1 = nil
if v1 then v1 = 1 end
emit(v1)
local e1 = 0
local function side() e1 = e1 + 1; return e1 end
local e2 = e1
side()
emit(e1, e2)                    -- 1 0
local n1 = 4
local n2 = n1
n1 = n1 + n2
emit(n1, n2)                    -- 8 4
print(table.concat(out, " "))

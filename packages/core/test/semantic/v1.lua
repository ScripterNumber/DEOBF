-- prism: vm
-- VM-residual style: varargs-pack helper, register table, multiple results through a top marker
local PACK = function(...)
  local n = select("#", ...)
  if n == 0 then return 0, {} end
  return n, { ... }
end
local function f3(a, b, c) return a, b, c end
local function many(...) return ... end
local function F(...)
  local R = table.create(20)
  local N, ARGS = PACK(...)
  local n, t, j
  R[1] = ARGS[1]
  -- call with all results of another call
  R[2] = print
  R[3] = "x"
  R[4] = many
  R[5] = 1
  R[6] = nil
  R[7] = 3
  n, t = PACK(R[4](table.unpack(R, 5, 7)))
  n = n + 4 - 1
  j = 0
  for i = 4, n do j = j + 1; R[i] = t[j] end
  R[2](table.unpack(R, 3, n))
  -- chained: print(many(many("p", "q")))
  R[2] = print
  R[3] = many
  R[4] = many
  R[5] = "p"
  R[6] = "q"
  n, t = PACK(R[4](table.unpack(R, 5, 6)))
  n = n + 4 - 1
  j = 0
  for i = 4, n do j = j + 1; R[i] = t[j] end
  n, t = PACK(R[3](table.unpack(R, 4, n)))
  n = n + 3 - 1
  j = 0
  for i = 3, n do j = j + 1; R[i] = t[j] end
  R[2](table.unpack(R, 3, n))
  -- list store into a fresh table
  R[2] = {}
  R[3] = "a"
  R[4] = many
  R[5] = "b"
  R[6] = "c"
  n, t = PACK(R[4](table.unpack(R, 5, 6)))
  n = n + 4 - 1
  j = 0
  for i = 4, n do j = j + 1; R[i] = t[j] end
  local T = R[2]
  table.move(R, 3, n, 1, T)
  print(#R[2], R[2][1], R[2][2], R[2][3])
  -- list store into an existing table at an offset
  R[8] = { "k1", "k2", "k3" }
  R[9] = many
  R[10] = "m"
  n, t = PACK(R[9](R[10], nil, "z"))
  n = n + 9 - 1
  j = 0
  for i = 9, n do j = j + 1; R[i] = t[j] end
  table.move(R, 9, n, 2, R[8])
  print(R[8][1], R[8][2], R[8][3], R[8][4])
  -- varargs after the first parameter
  R[2] = print
  R[3] = R[1]
  local c = N - 1 - 1
  if not (c < 0) then else c = -1 end
  j = 0
  for i = 4, 4 + c do R[i] = ARGS[2 + j]; j = j + 1 end
  R[2](table.unpack(R, 3, 4 + c))
  -- fixed number of results
  n, t = PACK(f3(7, 8, 9))
  R[5] = t[1]
  R[6] = t[2]
  print(R[5], R[6])
  -- results nobody takes
  n, t = PACK(print("side effect"))
  -- return all results
  R[2] = many
  R[3] = "r1"
  R[4] = "r2"
  n, t = PACK(R[2](table.unpack(R, 3, 4)))
  n = n + 2 - 1
  j = 0
  for i = 2, n do j = j + 1; R[i] = t[j] end
  do return table.unpack(R, 2, n) end
end
print(F("A", "B", nil, "D"))
print(F())
print(select("#", F(1)))

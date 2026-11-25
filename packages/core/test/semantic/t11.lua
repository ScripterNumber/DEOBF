-- t11: flattened state machines with unstructured shapes (multi-level jumps, break regions, irreducible cycles)
local function sm1(n)
  -- nested loops; the inner loop continues / breaks the OUTER loop directly
  local out = {}
  local st = 1
  local i, j = 0, 0
  while true do
    if st == 1 then
      i = i + 1; j = 0
      if i > n then st = 9 else st = 2 end
    elseif st == 2 then
      j = j + 1
      if j > i then st = 1 else st = 3 end
    elseif st == 3 then
      if (i * j) % 5 == 0 then out[#out + 1] = 'c' .. i .. j; st = 1
      elseif i + j == 11 then out[#out + 1] = 'b' .. i .. j; st = 9
      else out[#out + 1] = tostring(i * j); st = 2 end
    elseif st == 9 then
      break
    end
  end
  return table.concat(out, ',')
end

local function sm2(t)
  -- loop with a break region that has code (exits: 50 normal, 30 break-with-code); both reach 60
  local s = 10
  local acc, k = 0, 0
  while true do
    if s == 10 then k = k + 1; if k > #t then s = 50 else s = 20 end
    elseif s == 20 then if t[k] < 0 then s = 30 else s = 40 end
    elseif s == 30 then acc = acc * 2; s = 60
    elseif s == 40 then acc = acc + t[k]; s = 10
    elseif s == 50 then acc = acc + 1000; s = 60
    elseif s == 60 then acc = acc - 1; s = 70
    elseif s == 70 then break
    end
  end
  return acc, k
end

local function sm3(x)
  -- irreducible: the cycle {2,3} is entered at 2 or at 3
  local s = 1
  local out, n = '', 0
  while true do
    if s == 1 then if x > 3 then s = 2 else s = 3 end
    elseif s == 2 then out = out .. 'a'; n = n + 1; if n > 5 then s = 4 else s = 3 end
    elseif s == 3 then out = out .. 'b'; n = n + 2; if n > 7 then s = 4 else s = 2 end
    elseif s == 4 then break
    end
  end
  return out, n
end

local function sm4(t)
  -- dispatcher exit from inside a nested loop whose own follow is elsewhere; return inside a break region
  local s = 1
  local i, r = 0, 0
  while true do
    if s == 1 then i = i + 1; if i > #t then s = 5 else s = 2 end
    elseif s == 2 then
      if t[i] == 0 then s = 8                         -- leave the whole machine from inside the loop
      elseif t[i] < 0 then s = 6 else s = 3 end
    elseif s == 3 then r = r + t[i]; s = 1
    elseif s == 5 then r = r * 10; s = 7
    elseif s == 6 then if r > 100 then return 'big', r end; r = -r; s = 7
    elseif s == 7 then r = r + 0.5; s = 8
    elseif s == 8 then break
    end
  end
  return 'end', r, i
end

print(sm1(4)); print(sm1(7))
print(sm2({ 1, 2, 3 })); print(sm2({ 5, -1, 7 })); print(sm2({}))
print(sm3(1)); print(sm3(5))
print(sm4({ 1, 2, 3 })); print(sm4({ 4, 0, 9 })); print(sm4({ 50, 60, -1 })); print(sm4({ 2, -3 }))

local function f(A, B, C, R)
  local var53, var55, var58, var59, var61, z, var57, var60, var62
  var53 = B; var62 = C; var60 = R[var53]
  z = 176806; var55 = 176806; var59 = 176806; var58 = false
  for i13 = 62, 1099, 117 do
    if i13 > 647 and i13 < 881 then
      var58 = A
    elseif i13 < 647 and i13 > 413 then
      var55 = var55 + z
    elseif i13 < 179 then
      var61 = table.move
    elseif i13 < 413 and i13 > 179 then
      var55 = var53
      continue
    elseif i13 < 296 and i13 > 62 then
      var59 = R
    elseif i13 < 998 and i13 > 764 then
      z = z + var58
      continue
    elseif i13 > 881 then
      var58 = var62
      break
    elseif i13 > 530 and i13 < 764 then
      z = var53
      continue
    elseif i13 < 530 and i13 > 296 then
      z = 1
      continue
    end
  end
  var57 = 1
  for i14 = 22, 24, 2 do
    if i14 > 22 then
      var61(var59, var55, z, var58, var57)
    else
      var58 = var58 + var57
      var57 = var60
      continue
    end
  end
end
local R = {[1] = {}, [2] = 10, [3] = 20}
f(2, 1, 0, R)
print(R[1][1], R[1][2])

-- PRISM vm_specialize: residual program of the VM interpreter (one maker per proto).
-- PROTOS[n](upvalues) returns the closure for proto n; PROTO_n / K_n are records of the dump.
-- interpreter runs inside a protected call (E[33]()); handler returns are routed through its 1-statement epilogue
-- interpreter: fetch t = s[W] @L1406; proto param 'R', fields X=[9] x=[4] j=[2] U=[1] I=[10] o=[3] N=[6] s=[11] y=[5]; closure maker stored in E[57]
-- 3 proto(s) in the dump: #1(1118) #10(6) #19(36)
-- helper table E: 37 library function slot(s) resolved
-- self-modifying bytecode: 38 written slot(s); 52 patched-slot read(s) resolved statically (4 phase(s)), 4 selected at run time, 12 one-time patch trampoline(s) folded (the patching chain always runs; its stores are idempotent, its scratch registers are dead at the join), 14 unreachable block(s) removed
-- 36 self-modifying opcode store(s) removed (the patched opcode has the same meaning)
-- 1630 helper-table read(s) replaced by library functions
-- patch round 1: 28 written slot(s) of dump records (1 with computed values)
-- patch round 2: 30 written slot(s) of dump records (0 with computed values)
-- patch round 3: 30 written slot(s) of dump records (0 with computed values)
-- patch rounds oscillate: union of the last two patch sets used
-- patch check: 2 store(s) found in the cleaned code outside the patch set (K_3[261], K_7[797]) — another round
-- one-time patch flags: 38 guard value(s) imply 330 slot value(s) (the slots the patch chain closed by the flag always writes; verified self-consistent in 4 analysis phase(s))
-- patched-slot reads in the structured code: 0 resolved, 4 still read at run time (K_7×3, K_25×1)
-- 16 store(s) into 5 record(s) that are never read any more removed
-- 12 idempotent record guard(s) folded
-- 29 store(s) into 4 dump record(s) and 1 one-time patch guard(s) removed: the residual program never reads these records otherwise (self-modifying bytecode leftovers)
-- 6 multiple-results / varargs register range(s) fused back into calls, returns, assignments and table constructors (registers above an instruction's operands are taken as dead after it, as in compiled code)
-- run-time written slots of dump records (self-modifying bytecode): 38
--   K_31[101] <- 15
--   K_7[1053] <- 185
--   K_7[171] <- 17
--   K_31[171] <- 127
--   K_7[257] <- 169
--   K_2[956] <- 9
--   K_7[45] <- 1079
--   K_31[254] <- 175
--   K_7[828] <- 250
--   K_31[1104] <- 40
--   K_7[740] <- 17
--   K_3[597] <- 9
--   K_7[18] <- 8
--   K_2[900] <- 20
--   K_7[99] <- 894
--   K_2[655] <- 19
--   K_7[1118] <- 455
--   K_31[1076] <- 31
--   K_7[549] <- 130
--   K_2[177] <- 19
--   K_7[686] <- 176
--   K_31[746] <- 87
--   K_7[555] <- 1057
--   K_29[9] <- 121
--   K_20[9] <- 13
--   K_20[30] <- 0
--   K_29[30] <- 30
--   K_25[29] <- 1
--   K_25[12] <- 1
--   K_25[2] <- 13
--   K_7[608] <- 5
--   K_31[608] <- 166
--   K_3[608] <- 0
--   K_7[873] <- 607
--   K_31[378] <- 93
--   K_7[554] <- 377
--   K_3[261] <- 30
--   K_7[797] <- 257
local PROTOS = {};
PROTOS[1] = function(k, K)
  K = function(...)
    local W, h, l, M, H, T, L = 1, table.create(56), 1;
    local h_1, h_2, h_3, h_4, h_5, h_6, h_7, h_8, h_9, h_10, h_11, h_12, h_13, h_14, h_15, h_16, h_17, h_18, h_19, h_20, h_21, h_22, h_23, h_24, h_25, h_26, h_27, h_28, h_29, h_30, h_31, h_32, h_33, h_34;
    local S, w, m, i = 0, 1, (getfenv());
    local g;
    local p, P;
    print("=" .. string.rep("=", 59));
    print("MINI RPG WORLD GENERATOR");
    h_1 = print;
    h_1("=" .. string.rep("=", 59));
    print("Reference: https://create.roblox.com/docs/luau");
    print("");
    p = PROTOS[10](false);
    h_2 = p();
    h_3 = table.create(8);
    h_4 = { name = "Plains", sym = "." };
    h_5 = { name = "Forest", sym = "f" };
    h_6 = { name = "Hills", sym = "^" };
    h_7 = { name = "Mountains", sym = "M" };
    h_8 = { name = "Water", sym = "~" };
    h_9 = { name = "Desert", sym = ":" };
    h_10 = { name = "Swamp", sym = "s" };
    h_11 = { name = "Tundra", sym = "t" };
    h_3[1] = h_4;
    h_3[2] = h_5;
    h_3[3] = h_6;
    h_3[4] = h_7;
    h_3[5] = h_8;
    h_3[6] = h_9;
    h_3[7] = h_10;
    h_3[8] = h_11;
    print("TERRAIN TYPES:");
    L = { [5] = nil, [1] = nil, [3] = nil, [4] = nil };
    M = #h_3 + 0;
    i = 0;
    while true do
      i = i + 1;
      if i <= M then
        h_8 = print;
        h_9 = tostring(i);
        h_11 = " [" .. h_3[i].sym .. "]";
        h_10 = ". " .. h_3[i].name .. h_11;
        P = h_9 .. h_10;
        h_9 = "  " .. P;
        h_8(h_9);
        continue;
      end
      break;
    end
    i = L[4];
    M = L[1];
    T = L[3];
    L = L[5];
    print("");
    h_6 = {};
    h_9 = "x" .. tostring(20) .. "):";
    P = tostring(40) .. h_9;
    print("WORLD MAP (" .. P);
    h_7 = print;
    h_8 = "+" .. string.rep("-", 40) .. "+";
    h_7(h_8);
    L = { [5] = L, [1] = M, [3] = T, [4] = i };
    T = 1;
    M = 20;
    i = 0;
    while true do
      i = i + T;
      if not (T <= 0) then
        g = i <= M;
      else
        g = i >= M;
      end
      if g then
        h_10 = i;
        h_11 = "|";
        L = { [5] = L, [1] = M, [3] = T, [4] = i };
        for i = 1, 40 do
          h_19 = h_10 * 0.5;
          h_17 = 0.4 * math.sin(i * 0.5) * math.cos(h_19);
          h_16 = math.sin(i * 0.2) * math.cos(h_10 * 0.2) + h_17;
          P = (h_16 + 1) / 2;
          if (P < 0.2) then
            h_17 = 5;
          elseif (P < 0.35) then
            h_17 = 1;
          elseif (P < 0.55) then
            h_17 = 2;
          elseif (P < 0.75) then
            h_17 = 3;
          else
            h_17 = 4;
          end
          if not (h_6[h_10] ~= nil) then
            h_6[h_10] = {};
          end
          h_6[h_10][i] = h_17;
          h_18 = h_3[h_17].sym;
          P = h_11 .. h_18;
          h_11 = P;
        end
        i = L[4];
        M = L[1];
        T = L[3];
        L = L[5];
        h_13 = h_11 .. "|";
        print(h_13);
        continue;
      end
      break;
    end
    i = L[4];
    M = L[1];
    T = L[3];
    L = L[5];
    print("+" .. string.rep("-", 40) .. "+");
    print("");
    h_7 = { "Oakvale", "Riverwood", "Stonehaven", "Mistwall", "Dawnstar", "Falconreach" };
    h_8 = {};
    print("TOWNS:");
    L = { [5] = L, [1] = M, [3] = T, [4] = i };
    for i = 1, 8 do
      h_13 = math.floor(h_2() * 38) + 2;
      h_14 = math.floor(h_2() * 18) + 2;
      h_15 = math.floor(h_2() * #h_7) + 1;
      h_16 = math.floor(h_2() * 100) + 1;
      h_17 = h_7[h_15] .. " " .. tostring(h_16);
      table.insert(h_8, { name = h_17, x = h_13, y = h_14 });
      h_18 = print;
      h_21 = "," .. tostring(h_14) .. ")";
      h_20 = ". " .. h_17 .. " at (" .. tostring(h_13) .. h_21;
      h_19 = "  " .. tostring(i) .. h_20;
      h_18(h_19);
    end
    i = L[4];
    M = L[1];
    T = L[3];
    L = L[5];
    print("");
    h_9 = table.create(4);
    h_10 = { name = "Arthas", class = "Warrior", hp = 100, dmg = 25 };
    P = { name = "Liliana", class = "Mage", hp = 70, dmg = 35 };
    h_12 = { name = "Rexar", class = "Hunter", hp = 85, dmg = 28 };
    h_13 = { name = "Maiev", class = "Rogue", hp = 75, dmg = 32 };
    h_9[1] = h_10;
    h_9[2] = P;
    h_9[3] = h_12;
    h_9[4] = h_13;
    print("HEROES:");
    L = { [5] = L, [1] = M, [3] = T, [4] = i };
    M = #h_9 + 0;
    i = 0;
    while true do
      i = i + 1;
      if i <= M then
        h_14 = h_9[i];
        h_15 = print;
        h_16 = tostring(i);
        h_17 = h_14.name;
        h_18 = h_14.class;
        h_19 = tostring(h_14.hp);
        h_21 = h_14.dmg;
        h_20 = " | DMG:" .. tostring(h_21);
        h_19 = " | HP:" .. h_19 .. h_20;
        h_18 = " the " .. h_18 .. h_19;
        h_17 = ". " .. h_17 .. h_18;
        P = h_16 .. h_17;
        h_16 = "  " .. P;
        h_15(h_16);
        continue;
      end
      break;
    end
    i = L[4];
    M = L[1];
    T = L[3];
    L = L[5];
    print("");
    print("COMBAT SIMULATION:");
    h_10 = h_9[1];
    h_11 = h_9[2];
    h_12 = h_10.hp;
    h_13 = h_11.hp;
    P = h_10.name .. " vs " .. h_11.name;
    print("  " .. P);
    L = { [5] = L, [1] = M, [3] = T, [4] = i };
    i = 1;
    while true do
      if i <= 5 then
        if not (h_12 <= 0) then
          if not (h_13 <= 0) then
            h_18 = math.floor(h_2() * h_10.dmg) + 10;
            h_19 = math.floor(h_2() * h_11.dmg) + 10;
            h_13 = h_13 - h_18;
            h_20 = print;
            h_21 = tostring(i);
            h_22 = h_10.name;
            h_23 = tostring(h_18);
            h_24 = h_11.name;
            h_25 = " HP: " .. tostring(math.max(0, h_13));
            h_24 = " -> " .. h_24 .. h_25;
            h_23 = " hits for " .. h_23 .. h_24;
            h_22 = ": " .. h_22 .. h_23;
            P = h_21 .. h_22;
            h_21 = "  Turn " .. P;
            h_20(h_21);
            if (0 < h_13) then
              h_12 = h_12 - h_19;
              h_20 = print;
              h_21 = h_11.name;
              h_22 = tostring(h_19);
              h_23 = h_10.name;
              h_24 = " HP: " .. tostring(math.max(0, h_12));
              h_23 = " -> " .. h_23 .. h_24;
              h_22 = " hits for " .. h_22 .. h_23;
              h_21 = "           " .. h_21 .. h_22;
              h_20(h_21);
            end
            i = i + 1;
            continue;
          end
        end
      end
      break;
    end
    i = L[4];
    M = L[1];
    T = L[3];
    L = L[5];
    if (h_12 <= 0) then
      h_15 = "  WINNER: " .. h_11.name;
      print(h_15);
    elseif (h_13 <= 0) then
      h_15 = "  WINNER: " .. h_10.name;
      print(h_15);
    else
      print("  DRAW!");
    end
    print("");
    h_14 = { "Iron Sword", "Leather Armor", "Health Potion", "Mana Potion", "Steel Shield", "Magic Ring" };
    print("SHOP ITEMS:");
    L = { [5] = L, [1] = M, [3] = T, [4] = i };
    M = #h_14 + 0;
    i = 0;
    while true do
      i = i + 1;
      if i <= M then
        h_19 = math.floor(h_2() * 100) + 20;
        h_20 = print;
        h_21 = tostring(i);
        h_22 = h_14[i];
        h_23 = " - " .. tostring(h_19) .. " gold";
        P = h_22 .. h_23;
        h_22 = ". " .. P;
        h_21 = "  " .. h_21 .. h_22;
        h_20(h_21);
        continue;
      end
      break;
    end
    i = L[4];
    M = L[1];
    T = L[3];
    L = L[5];
    print("");
    h_15 = { "Kill 5 goblins", "Find the lost artifact", "Escort the merchant", "Clear the dungeon", "Deliver the message", "Defeat the dragon" };
    h_16 = 0;
    print("QUESTS:");
    L = { [5] = L, [1] = M, [3] = T, [4] = i };
    M = #h_15 + 0;
    i = 0;
    while true do
      i = i + 1;
      if i <= M then
        h_21 = math.floor(h_2() * 150) + 50;
        h_22 = h_2();
        if (h_22 < 0.3) then
          h_16 = h_16 + 1;
          h_22 = print;
          h_23 = h_15[i];
          h_24 = " (+" .. tostring(h_21) .. " gold)";
          P = h_23 .. h_24;
          h_23 = "  [X] " .. P;
          h_22(h_23);
        else
          h_22 = print;
          h_23 = h_15[i];
          h_24 = " (" .. tostring(h_21) .. " gold)";
          P = h_23 .. h_24;
          h_23 = "  [ ] " .. P;
          h_22(h_23);
        end
        continue;
      end
      break;
    end
    i = L[4];
    M = L[1];
    T = L[3];
    L = L[5];
    print("  Completed: " .. tostring(h_16) .. "/" .. tostring(#h_15));
    print("");
    h_17 = { name = "Shadow Crypt", floors = 5 };
    h_18 = { 5, 4, 3, 3, 2 };
    print("DUNGEON: " .. h_17.name);
    h_19 = 100;
    h_20 = 0;
    h_22 = h_17.floors;
    L = { [5] = L, [1] = M, [3] = T, [4] = i };
    T = 1;
    M = h_22 + 0;
    i = 0;
    while true do
      i = i + T;
      if not (T <= 0) then
        g = i <= M;
      else
        g = i >= M;
      end
      if g then
        h_24 = i;
        h_25 = h_18[i];
        if not (h_25 ~= nil) then
          h_25 = 3;
        end
        h_26 = print;
        h_27 = tostring(i);
        h_28 = " - " .. tostring(h_25) .. " enemies";
        P = h_27 .. h_28;
        h_26("  Floor " .. P);
        L = { [5] = L, [1] = M, [3] = T, [4] = i };
        M = h_25 + 0;
        i = 0;
        while true do
          i = i + 1;
          if i <= M then
            h_30 = math.floor(h_2() * 30) + 10;
            h_19 = h_19 - h_30;
            h_31 = print;
            h_34 = " dmg | Party HP: " .. tostring(math.max(0, h_19));
            P = tostring(h_30) .. h_34;
            h_33 = " deals " .. P;
            h_32 = "    Enemy " .. tostring(i) .. h_33;
            h_31(h_32);
            if not (h_19 <= 0) then
              continue;
            end
          end
          break;
        end
        i = L[4];
        M = L[1];
        T = L[3];
        L = L[5];
        if (h_19 <= 0) then
          h_26 = print;
          h_27 = "  PARTY DIED at floor " .. tostring(h_24) .. "!";
          h_26(h_27);
        else
          h_26 = math.floor(h_2() * 100) + 20;
          h_20 = h_20 + h_26;
          h_27 = print;
          h_29 = " gold (total: " .. tostring(h_20) .. ")";
          h_28 = "    Floor cleared! +" .. tostring(h_26) .. h_29;
          h_27(h_28);
          continue;
        end
      end
      break;
    end
    if (0 < h_19) then
      print("  DUNGEON CLEARED! Final HP: " .. tostring(h_19) .. " | Gold: " .. tostring(h_20));
    end
    print("");
    h_21 = { "Sunny", "Rain", "Storm", "Snow", "Fog" };
    print("WEATHER LOG (10 days):");
    print("  Day " .. (" " .. tostring(1)) .. ": " .. h_21[math.floor(h_2() * #h_21) + 1]);
    print("  Day " .. (" " .. tostring(2)) .. ": " .. h_21[math.floor(h_2() * #h_21) + 1]);
    print("  Day " .. (" " .. tostring(3)) .. ": " .. h_21[math.floor(h_2() * #h_21) + 1]);
    print("  Day " .. (" " .. tostring(4)) .. ": " .. h_21[math.floor(h_2() * #h_21) + 1]);
    print("  Day " .. (" " .. tostring(5)) .. ": " .. h_21[math.floor(h_2() * #h_21) + 1]);
    print("  Day " .. (" " .. tostring(6)) .. ": " .. h_21[math.floor(h_2() * #h_21) + 1]);
    print("  Day " .. (" " .. tostring(7)) .. ": " .. h_21[math.floor(h_2() * #h_21) + 1]);
    print("  Day " .. (" " .. tostring(8)) .. ": " .. h_21[math.floor(h_2() * #h_21) + 1]);
    print("  Day " .. (" " .. tostring(9)) .. ": " .. h_21[math.floor(h_2() * #h_21) + 1]);
    print("  Day " .. tostring(10) .. ": " .. h_21[math.floor(h_2() * #h_21) + 1]);
    print("");
    print("=" .. string.rep("=", 59));
    print("FINAL STATS:");
    print("  Map cells: " .. tostring(800));
    print("  Towns: " .. tostring(#h_8));
    print("  Heroes: " .. tostring(#h_9));
    print("  Quests completed: " .. tostring(h_16) .. "/" .. tostring(#h_15));
    print("  Dungeon gold: " .. tostring(h_20));
    print("=" .. string.rep("=", 59));
    print("GENERATION COMPLETE!");
    print("https://create.roblox.com/docs/luau");
    return;
  end;
  return K;
end;
PROTOS[10] = function(k, K)
  K = function(...)
    local W, h, l, M, H, T, L = 1, table.create(4), 1;
    local S, w, m, i = 0, 1, (getfenv());
    local u, p, A;
    h[1] = 12345;
    A = {};
    p = PROTOS[19](A);
    if A then
      H = {};
      u = H[1];
      if not u then
        u = { [1] = 1, [2] = h };
        H[1] = u;
      end
      A[0] = u;
    end
    if H then
      for R, X in H do
        if R >= 1 then
          X[2] = X;
          X[3] = h[R];
          X[1] = 3;
          H[R] = nil;
        end
      end
    end
    return p;
  end;
  return K;
end;
PROTOS[19] = function(k, K)
  K = function(...)
    local W, h, l, M, H, T, L = 1, table.create(22), 1;
    local h_1;
    local S, w, m, i = 0, 1, (getfenv());
    local g;
    g = k[0];
    h_1 = (g[2][g[1]] * 1103515245 + 12345) % 4294967296;
    g = k[0];
    g[2][g[1]] = h_1;
    g = k[0];
    return g[2][g[1]] / 4294967296;
  end;
  return K;
end;

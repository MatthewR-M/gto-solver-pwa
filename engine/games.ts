// Small benchmark games with known (Kuhn, river toy) or well-studied (Leduc)
// solutions, used to validate the CFR core.

import { TreeBuilder, GameTree } from './cfr';

// ---------------------------------------------------------------------------
// Kuhn poker: 3-card deck (J, Q, K as ranks 0, 1, 2), both ante 1, one
// betting round, bet size 1. Known game value for player 0: -1/18.
// ---------------------------------------------------------------------------

export function buildKuhn(): GameTree {
  const b = new TreeBuilder();
  const deals: number[] = [];
  const probs: number[] = [];
  for (let c0 = 0; c0 < 3; c0++) {
    for (let c1 = 0; c1 < 3; c1++) {
      if (c1 === c0) continue;
      probs.push(1 / 6);
      const showdown = c0 > c1 ? 1 : -1;
      // P1 facing a bet: fold / call
      const p1VsBet = b.player(1, `K1:${c1}:b`, [
        b.terminal(1), // P1 folds -> P0 wins P1's ante
        b.terminal(showdown * 2), // call -> showdown for 2
      ]);
      // P0 after check-bet: fold / call
      const p0VsBet = b.player(0, `K0:${c0}:cb`, [
        b.terminal(-1),
        b.terminal(showdown * 2),
      ]);
      // P1 after a check: check (showdown) / bet
      const p1AfterCheck = b.player(1, `K1:${c1}:c`, [b.terminal(showdown), p0VsBet]);
      // P0 first action: check / bet
      const p0First = b.player(0, `K0:${c0}:`, [p1AfterCheck, p1VsBet]);
      deals.push(p0First);
    }
  }
  const root = b.chance(deals, probs);
  return b.build(root);
}

// ---------------------------------------------------------------------------
// Leduc Hold'em: deck of 6 cards (J, Q, K in two suits), both ante 1.
// Round 1 bet size 2, round 2 bet size 4, at most 2 raises per round.
// One board card is dealt between rounds. Pairing the board beats unpaired;
// otherwise higher private rank wins. Used as a convergence benchmark
// (exploitability -> 0); no closed-form value is asserted.
// ---------------------------------------------------------------------------

const LEDUC_BET = [2, 4];

interface LeducState {
  c0: number; // private card ids 0..5, rank = id >> 1
  c1: number;
  board: number; // -1 before the flop
  round: 0 | 1;
  inv0: number; // total invested including ante
  inv1: number;
  level: number; // current round wager level (per-player round commitment target)
  w0: number; // committed this round
  w1: number;
  raises: number;
  pendingLeft: number; // passive actions still needed to close the round
  toAct: 0 | 1;
  hist: string; // full action history (for perfect-recall infosets)
}

function leducShowdown(c0: number, c1: number, board: number): number {
  const r0 = c0 >> 1;
  const r1 = c1 >> 1;
  const rb = board >> 1;
  const pair0 = r0 === rb;
  const pair1 = r1 === rb;
  if (pair0 && !pair1) return 1;
  if (pair1 && !pair0) return -1;
  if (pair0 && pair1) return 0; // both pair the board: same pair rank
  if (r0 === r1) return 0;
  return r0 > r1 ? 1 : -1;
}

function buildLeducTree(): GameTree {
  const b = new TreeBuilder(10_000_000);

  function terminalShowdown(s: LeducState): number {
    const sd = leducShowdown(s.c0, s.c1, s.board);
    if (sd > 0) return b.terminal(s.inv1); // P0 wins P1's total investment
    if (sd < 0) return b.terminal(-s.inv0);
    return b.terminal((s.inv1 - s.inv0) / 2);
  }

  function dealBoard(s: LeducState): number {
    const children: number[] = [];
    const probs: number[] = [];
    for (let card = 0; card < 6; card++) {
      if (card === s.c0 || card === s.c1) continue;
      probs.push(1 / 4);
      children.push(
        act({
          ...s,
          board: card,
          round: 1,
          level: 0,
          w0: 0,
          w1: 0,
          raises: 0,
          pendingLeft: 2,
          toAct: 0,
          hist: s.hist + '/',
        }),
      );
    }
    return b.chance(children, probs);
  }

  function finishRound(s: LeducState): number {
    if (s.round === 0) return dealBoard(s);
    return terminalShowdown(s);
  }

  // Recursive betting state machine. `pendingLeft` counts passive actions
  // still needed to close the round: a round starts needing 2 (check-check
  // closes it), any aggressive action resets it to 1 (one response needed),
  // and each check/call decrements it. Matched wagers + pendingLeft 0 ends
  // the round.
  function act(s: LeducState): number {
    const me = s.toAct;
    const myW = me === 0 ? s.w0 : s.w1;
    const toCall = s.level - myW;
    const betSize = LEDUC_BET[s.round]!;
    const myRank = (me === 0 ? s.c0 : s.c1) >> 1;
    const boardRank = s.board < 0 ? -1 : s.board >> 1;
    const key = `L:${myRank}:${boardRank}:${s.hist}`;

    const actions: number[] = [];

    const withMove = (patch: Partial<LeducState>, tag: string): LeducState => ({
      ...s,
      ...patch,
      hist: s.hist + tag,
    });

    if (toCall > 0) {
      // fold
      actions.push(b.terminal(me === 0 ? -s.inv0 : s.inv1));
      // call
      const called: LeducState = withMove(
        me === 0
          ? { inv0: s.inv0 + toCall, w0: s.w0 + toCall, toAct: 1, pendingLeft: s.pendingLeft - 1 }
          : { inv1: s.inv1 + toCall, w1: s.w1 + toCall, toAct: 0, pendingLeft: s.pendingLeft - 1 },
        'c',
      );
      actions.push(finishRoundOrContinue(called));
      // raise (if allowed)
      if (s.raises < 2) {
        const add = toCall + betSize;
        const raised: LeducState = withMove(
          me === 0
            ? {
                inv0: s.inv0 + add,
                w0: s.w0 + add,
                level: s.level + betSize,
                raises: s.raises + 1,
                pendingLeft: 1,
                toAct: 1,
              }
            : {
                inv1: s.inv1 + add,
                w1: s.w1 + add,
                level: s.level + betSize,
                raises: s.raises + 1,
                pendingLeft: 1,
                toAct: 0,
              },
          'r',
        );
        actions.push(act(raised));
      }
      return b.player(me, key, actions);
    }

    // No bet to face: check or open/raise.
    const checked: LeducState = withMove(
      { toAct: (1 - me) as 0 | 1, pendingLeft: s.pendingLeft - 1 },
      'k',
    );
    actions.push(finishRoundOrContinue(checked));
    if (s.raises < 2) {
      const opened: LeducState = withMove(
        me === 0
          ? {
              inv0: s.inv0 + betSize,
              w0: s.w0 + betSize,
              level: s.level + betSize,
              raises: s.raises + 1,
              pendingLeft: 1,
              toAct: 1,
            }
          : {
              inv1: s.inv1 + betSize,
              w1: s.w1 + betSize,
              level: s.level + betSize,
              raises: s.raises + 1,
              pendingLeft: 1,
              toAct: 0,
            },
        'b',
      );
      actions.push(act(opened));
    }
    return b.player(me, key, actions);
  }

  function finishRoundOrContinue(s: LeducState): number {
    // Round is over when wagers match and no passive actions remain.
    if (s.w0 === s.w1 && s.pendingLeft <= 0) return finishRound(s);
    return act(s);
  }

  const deals: number[] = [];
  const probs: number[] = [];
  for (let c0 = 0; c0 < 6; c0++) {
    for (let c1 = 0; c1 < 6; c1++) {
      if (c1 === c0) continue;
      probs.push(1 / 30);
      deals.push(
        act({
          c0,
          c1,
          board: -1,
          round: 0,
          inv0: 1,
          inv1: 1,
          level: 0,
          w0: 0,
          w1: 0,
          raises: 0,
          pendingLeft: 2,
          toAct: 0,
          hist: '',
        }),
      );
    }
  }
  const root = b.chance(deals, probs);
  return b.build(root);
}

let _leduc: GameTree | null = null;
export function buildLeduc(): GameTree {
  if (!_leduc) _leduc = buildLeducTree();
  return _leduc;
}

// ---------------------------------------------------------------------------
// Analytic river toy game ("nuts-or-air vs bluff-catcher"):
// Pot 100 already in the middle (50 from each player, sunk).
// Player 1 is dealt the nuts or pure air with probability 1/2 each and may
// check or bet 50. Player 2 holds a bluff-catcher (beats air, loses to nuts)
// and may fold or call.
// Utilities are stack changes relative to each player's sunk 50.
//
// Derivation (see tests): P1 bets all nuts and bluffs air with probability
// 1/3; P2 calls with probability 2/3; game value for P1 is exactly 50/3.
//   - P2 indifference: facing a bet, P(nuts | bet) = 1/(1+x) where x is the
//     bluff frequency. EV(call) = 100(x-1)/(1+x); EV(fold) = -50.
//     Setting them equal gives x = 1/3.
//   - P1 bluff indifference: EV(bet air) = 50(1-y) - 100y (y = call freq),
//     EV(check air) = -50, so y = 2/3.
//   - Value: nuts are always bet, EV = (1/3)(50) + (2/3)(100) = 250/3;
//     air EV is -50; overall (250/3 - 50) / 2 = 50/3.
// ---------------------------------------------------------------------------

export function buildRiverToy(): GameTree {
  const b = new TreeBuilder();
  // Payoffs below are player 1's utility (player index 0 in the tree plays
  // the role of the bettor "P1" of the writeup). "Receives" means the whole
  // final pot, including the bettor's own bets coming back when he wins.
  function branch(isNuts: boolean): number {
    // P2 folds facing the 50 bet: final pot 150, bettor receives it.
    // bettor u = 150 (received) - 50 (bet) - 50 (sunk) = +50
    const foldNode = b.terminal(50);
    // call: pot becomes 200.
    // nuts: bettor receives 200 -> u = 200 - 50 - 50 = +100
    // air:  bettor receives 0   -> u = 0 - 50 - 50 = -100
    const callNode = b.terminal(isNuts ? 100 : -100);
    const p2Node = b.player(1, 'T2:vsbet', [foldNode, callNode]);
    // check: showdown for the 100 pot.
    // nuts: u = 100 - 0 - 50 = +50 ; air: u = 0 - 0 - 50 = -50
    const checkNode = b.terminal(isNuts ? 50 : -50);
    return b.player(0, isNuts ? 'T1:nuts' : 'T1:air', [checkNode, p2Node]);
  }
  const root = b.chance([branch(true), branch(false)], [0.5, 0.5]);
  return b.build(root);
}

export const RIVER_TOY_SOLUTION = {
  bluffFrequency: 1 / 3, // P1 bets air with this probability
  callFrequency: 2 / 3, // P2 calls with this probability
  valueBetFrequency: 1, // P1 always bets the nuts
  gameValue: 50 / 3, // for the bettor
};

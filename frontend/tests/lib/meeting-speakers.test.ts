import { expect, test } from 'bun:test';
import { speakerLookup } from '../../src/lib/meeting-speakers';

test('labels repeated turns consistently and adds durations for the same speaker', () => {
  const speaker = speakerLookup([[0, 2, 1], [2, 5, 2], [5, 7, 1]]);
  expect(speaker(0, 7)).toBe(1);
  expect(speaker(2, 5)).toBe(2);
  expect(speaker(6)).toBe(1);
});

test('handles overlapping turns, exact boundaries and silence', () => {
  const speaker = speakerLookup([[1, 10, 1], [3, 4, 2], [11, 20, 2]]);
  expect(speaker(6, 7)).toBe(1);
  expect(speaker(10)).toBeUndefined();
  expect(speaker(11)).toBe(2);
  expect(speaker(21, 22)).toBeUndefined();
  expect(speaker(9, 8)).toBeUndefined();
});

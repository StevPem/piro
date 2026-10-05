'use strict';

const { CivDriver } = require('./driver');
const frame = require('./frame');
const commands = require('./commands');
const scope = require('./scope');

module.exports = {
  CivDriver,
  ...commands,
  freqToBCD: frame.freqToBCD,
  bcdToFreq: frame.bcdToFreq,
  FrameParser: frame.FrameParser,
  encodeFrame: frame.encodeFrame,
  ScopeLineAssembler: scope.ScopeLineAssembler,
  decodeScopeChunk: scope.decodeScopeChunk,
};

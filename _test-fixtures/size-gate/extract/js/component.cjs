#!/usr/bin/env node
const note = "eslint-disable max-lines";
const re = /\/\/ not a comment/;

module.exports = function Badge(props) {
  return <span>{props.label}</span>;
}; // trailing

exports.foo = function () {
  return 1;
};

module.exports = function () {
  return 1;
};

module.exports = () => {
  return 2;
};

module.exports.bar = () => 3;

module.exports = (function () {
  return 4;
});

module.exports = (() => 5);

module.exports = (function Named() {
  return 6;
});

module["exports"] = function () {
  return 7;
};

module['exports'] = function Quoted() {
  return 8;
};

exports["foo"] = function () {
  return 9;
};

module.exports["baz"] = () => 10;

jobs["run"](() => 11);

exports.wrapped = (() => 12);

module.exports["qux"] = (function () {
  return 13;
});

run((() => 14));

exports.nested = (((() => 15)));

(function () {
  return 16;
})();

exports[`tpl`] = function () {
  return 17;
};

module[`exports`] = function () {
  return 18;
};

exports[`${key}`] = function () {
  return 19;
};

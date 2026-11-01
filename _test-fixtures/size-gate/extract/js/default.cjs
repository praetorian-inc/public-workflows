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

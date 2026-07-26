// Tab navigation
document.addEventListener('DOMContentLoaded', function () {
  var tabs = document.querySelectorAll('.nav-tab');
  var sections = document.querySelectorAll('.section');

  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      tabs.forEach(function (t) { t.classList.remove('active'); });
      sections.forEach(function (s) { s.classList.remove('active'); });
      tab.classList.add('active');
      var target = document.getElementById(tab.getAttribute('data-section'));
      if (target) target.classList.add('active');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  // Accordion toggle
  var accBtns = document.querySelectorAll('.accordion-btn');
  accBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var body = btn.nextElementSibling;
      var isOpen = btn.classList.contains('open');
      btn.classList.toggle('open', !isOpen);
      if (body) body.classList.toggle('open', !isOpen);
    });
  });
});

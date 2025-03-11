// public/js/script.js

// JavaScript for Mobile Menu and Modal Popup
document.addEventListener('DOMContentLoaded', () => {
  // Mobile Menu Toggle
  const menuToggle = document.querySelector('.menu-toggle');
  const navMenu = document.querySelector('.nav-menu');

  menuToggle.addEventListener('click', () => {
    navMenu.classList.toggle('active');
  });

  // Modal Popup Elements
  const modal = document.getElementById('medassist-modal');
  const medassistLink = document.getElementById('medassist-link');
  const closeBtn = document.getElementsByClassName('close')[0];

  // Check if elements exist before adding event listeners
  if (medassistLink && modal && closeBtn) {
    // Open Modal on MedAssist Logo Click
    medassistLink.addEventListener('click', function (event) {
      event.preventDefault(); // Prevent default action
      modal.style.display = 'block';
    });

    // Close Modal on Close Button Click
    closeBtn.addEventListener('click', function () {
      modal.style.display = 'none';
    });

    // Close Modal on Outside Click
    window.addEventListener('click', function (event) {
      if (event.target == modal) {
        modal.style.display = 'none';
      }
    });
  }
});


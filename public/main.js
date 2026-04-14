async function cyclePriority(event, exhibitionId, buttonElement) {
    // 1. Stop the <a> tag from opening the museum link
    event.preventDefault();
    event.stopPropagation();

    // 2. Define the cycle order
    const currentState = buttonElement.getAttribute('data-current');
    const cycleMap = {
        'Unprioritized': 'Recommended',
        'Recommended': 'Must See',
        'Must See': 'Nice to See',
        'Nice to See': 'Ignore',
        'Ignore': 'Unprioritized',
        'Attended': 'Unprioritized'
    };
    const nextState = cycleMap[currentState] || 'Must See';

    // 3. Instant UI Update (Optimistic)
    buttonElement.innerText = window.appConfig.translations[nextState];
    buttonElement.setAttribute('data-current', nextState);

    // Swap the CSS classes to change the color
    const oldClass = currentState.replace(/\s+/g, '-').toLowerCase();
    const newClass = nextState.replace(/\s+/g, '-').toLowerCase();
    buttonElement.classList.remove(oldClass);
    buttonElement.classList.add(newClass);

    // Update the parent card's data-priority attribute so filtering works immediately
    const cardElement = buttonElement.closest('.card');
    if (cardElement) {
        cardElement.setAttribute('data-priority', nextState);
    }

    // 4. Silent Save to Database
    try {
        await fetch('/update-priority', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ exhibitionId, priority: nextState })
        });
    } catch (err) {
        console.error("Network error:", err);
    }
}

async function toggleVenueFavorite(event, spanElement) {
    event.preventDefault();
    event.stopPropagation();

    const venueId = spanElement.getAttribute('data-venue-id');
    const isCurrentlyHighValue = spanElement.getAttribute('data-is-high-value') === 'true';
    const nextState = !isCurrentlyHighValue;

    // Optimistic UI update for ALL instances of this venue on the page
    document.querySelectorAll(`.venue-heart-btn[data-venue-id="${venueId}"]`).forEach(el => {
        el.innerText = nextState ? '♥️' : '♡';
        el.setAttribute('data-is-high-value', nextState.toString());
        el.style.color = nextState ? '#d73a49' : 'inherit';

        // Update the parent card's data attributes and optimistic priority
        const cardElement = el.closest('.card');
        if (cardElement) {
            cardElement.setAttribute('data-is-high-value', nextState.toString());
            
            const currentPriority = cardElement.getAttribute('data-priority');
            const badgeBtn = cardElement.querySelector('.priority-badge');
            
            if (nextState && currentPriority === 'Unprioritized') {
                cardElement.setAttribute('data-priority', 'Recommended');
                if (badgeBtn) {
                    badgeBtn.innerText = window.appConfig.translations['Recommended'];
                    badgeBtn.setAttribute('data-current', 'Recommended');
                    badgeBtn.classList.replace('unprioritized', 'recommended');
                }
            } else if (!nextState && currentPriority === 'Recommended') {
                cardElement.setAttribute('data-priority', 'Unprioritized');
                if (badgeBtn) {
                    badgeBtn.innerText = window.appConfig.translations['Unprioritized'];
                    badgeBtn.setAttribute('data-current', 'Unprioritized');
                    badgeBtn.classList.replace('recommended', 'unprioritized');
                }
            }
        }
    });

    // Re-apply the current filter to instantly refresh the grid view
    const activeFilterBtn = document.querySelector('.filter-btn.active');
    if (activeFilterBtn) {
        activeFilterBtn.click();
    }

    try {
        await fetch('/toggle-favorite-venue', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ venueId, isFavorite: nextState })
        });
    } catch (err) {
        console.error("Network error:", err);
    }
}

function applyFilter(filterType, btnElement) {
    document.querySelectorAll('.filter-btn').forEach(btn => btn.classList.remove('active'));
    btnElement.classList.add('active');

    const grid = document.getElementById('exhibition-grid');
    const cards = Array.from(grid.querySelectorAll('.card'));
    
    // Clean up existing section headers
    grid.querySelectorAll('.section-header').forEach(el => el.remove());

    let visibleCount = 0;
    const visibleCards = [];

    cards.forEach(card => {
        let show = false;
        const priority = card.getAttribute('data-priority');
        const isNew = card.getAttribute('data-is-new') === 'true';
        const isClosingSoon = card.getAttribute('data-is-closing-soon') === 'true';
        const isHighValue = card.getAttribute('data-is-high-value') === 'true';
        const isFree = card.getAttribute('data-is-free') === 'true';
        const isActive = card.getAttribute('data-is-active') === 'true';

        if (filterType === 'All') show = isActive && (priority !== 'Ignore');
        else if (filterType === 'New This Week') show = isActive && isNew && (priority !== 'Ignore');
        else if (filterType === 'Closing Soon') show = isActive && isClosingSoon && (priority !== 'Ignore');
        else if (filterType === 'High Value') show = isActive && isHighValue && (priority !== 'Ignore');
        else if (filterType === 'Free') show = isActive && isFree && (priority !== 'Ignore');
        else if (filterType === 'Attended') show = (priority === 'Attended');
        else if (filterType === 'Must See') show = (priority === 'Must See');
        else show = isActive && (priority === filterType);

        card.style.display = show ? 'flex' : 'none';
        if (show) {
            visibleCount++;
            visibleCards.push(card);
        }
    });

    // Define priority sort order
    const priorityOrder = {
        'Must See': 1,
        'Recommended': 2,
        'Nice to See': 3,
        'Unprioritized': 4,
        'Attended': 5,
        'Ignore': 6
    };

    // Sort visible cards
    visibleCards.sort((a, b) => {
        const dateA = new Date(a.getAttribute('data-end-date') || '2099-01-01').getTime();
        const dateB = new Date(b.getAttribute('data-end-date') || '2099-01-01').getTime();
        
        if (filterType === 'Closing Soon' || filterType === 'New This Week') {
            return dateA - dateB;
        } else {
            const prioA = priorityOrder[a.getAttribute('data-priority')] || 99;
            const prioB = priorityOrder[b.getAttribute('data-priority')] || 99;
            if (prioA !== prioB) return prioA - prioB;
            return dateA - dateB; // Secondary sort by date
        }
    });

    // Re-append sorted cards and inject section headers
    let currentPriority = null;
    const showHeaders = ['All', 'High Value', 'Free'].includes(filterType);

    visibleCards.forEach(card => {
        const priority = card.getAttribute('data-priority');
        if (showHeaders && priority !== currentPriority) {
            const header = document.createElement('div');
            header.className = 'section-header';
            header.innerText = window.appConfig.sectionHeaders[priority] || window.appConfig.translations[priority] || priority;
            grid.appendChild(header);
            currentPriority = priority;
        }
        grid.appendChild(card);
    });

    document.getElementById('exhibition-count').innerText = visibleCount;
    
    if (visibleCount === 0) {
        document.getElementById('empty-state').style.display = 'block';
        if (!window.appConfig.isLoggedIn && filterType === 'Must See') {
            document.getElementById('empty-state-login').style.display = 'block';
            document.getElementById('empty-state-generic').style.display = 'none';
        } else {
            document.getElementById('empty-state-login').style.display = 'none';
            document.getElementById('empty-state-generic').style.display = 'block';
        }
    } else {
        document.getElementById('empty-state').style.display = 'none';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const activeBtn = document.querySelector('.filter-btn.active');
    if (activeBtn) applyFilter('All', activeBtn);
});
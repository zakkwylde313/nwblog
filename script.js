document.addEventListener('DOMContentLoaded', async function() { // !!!! async 추가 !!!!

    // Firebase 설정값 실제 값으로 변경
    const firebaseConfig = {
        apiKey: "AIzaSyA-j8vIIikH2jbBOvRsKJogBL06a-hHapI",
        authDomain: "nwblog-daa43.firebaseapp.com",
        projectId: "nwblog-daa43",
        storageBucket: "nwblog-daa43.appspot.com",
        messagingSenderId: "796227461113",
        appId: "1:796227461113:web:6a2edffe1d90641bd06728"
    };

    // Firebase 초기화
    if (!firebase.apps.length) {
        firebase.initializeApp(firebaseConfig);
        console.log("Firebase 앱 초기화 성공");
    } else {
        firebase.app();
    }

    const db = firebase.firestore();
    const auth = firebase.auth();

    // --- 주요 UI 요소들 ---
    const loginForm = document.getElementById('login-form');
    const loginEmailInput = document.getElementById('login-email');
    const loginPasswordInput = document.getElementById('login-password');
    const loginButton = document.getElementById('login-button');
    const loginErrorMessage = document.getElementById('login-error-message');
    const userInfoDisplay = document.getElementById('user-info');
    const userEmailDisplay = document.getElementById('user-email-display');
    const logoutButton = document.getElementById('logout-button');
    const adminControls = document.getElementById('admin-controls');

    const addBlogModal = document.getElementById('add-blog-modal');
    const showAddBlogModalButton = document.getElementById('show-add-blog-modal-button');
    const closeModalButton = document.getElementById('close-modal-button');
    const cancelAddBlogButton = document.getElementById('cancel-add-blog-button');
    const addBlogForm = document.getElementById('add-blog-form');

    // !!!! 대시보드 테이블 tbody 와 empty 메시지 요소 !!!!
    const dashboardTbody = document.getElementById('blog-dashboard-tbody');
    const dashboardEmptyMessage = document.getElementById('dashboard-empty-message');

    const blogListElement = document.getElementById('blog-list'); // 기존 상세 목록 ul
    const emptyMessageElement = document.getElementById('empty-message'); // 기존 상세 목록 empty 메시지

    const totalBlogsValueElement = document.getElementById('total-blogs-value');
    const activeBlogsValueElement = document.getElementById('active-blogs-value');
    const inactiveBlogsValueElement = document.getElementById('inactive-blogs-value');

    const statusFilterElement = document.getElementById('status-filter');
    const sortOrderElement = document.getElementById('sort-order');
    const refreshButton = document.querySelector('.refresh-button');
    const testUpdateRssButton = document.getElementById('test-update-rss-button');

    const nextChallengeDayDisplay = document.getElementById('next-challenge-day-display');
    const timeRemainingDisplay = document.getElementById('time-remaining-display');

    let allFetchedBlogs = [];
    let visitedLinks = JSON.parse(localStorage.getItem('visitedBlogPosts')) || {};
    let countdownIntervalId = null;

    const CHALLENGE_EPOCH_START_DATE_STRING = '2025-05-10T00:00:00+09:00';
    const CHALLENGE_PERIOD_WEEKS = 2;
    const CHALLENGE_START_DATE_FOR_COUNTING_POSTS_UTC = new Date('2025-05-10T00:00:00+09:00'); // KST 기준


    function formatKoreanDate(dateString, includeTime = false) {
        if (!dateString) return '정보 없음';
        try {
            const date = new Date(dateString);
            if (isNaN(date.getTime())) {
                // console.warn("formatKoreanDate: Invalid date from string:", dateString);
                return '날짜 형식 오류';
            }
            const year = date.getFullYear();
            const month = date.getMonth() + 1;
            const day = date.getDate();
            if (includeTime) {
                const hours = date.getHours();
                const minutes = date.getMinutes();
                return `${year}년 ${month}월 ${day}일 ${String(hours).padStart(2, '0')}시 ${String(minutes).padStart(2, '0')}분`;
            } else { return `${year}년 ${month}월 ${day}일`; }
        } catch (e) { console.warn("날짜 포맷 변경 중 오류:", dateString, e); return '날짜 변환 오류'; }
    }

    function getCurrentChallengeDeadline() {
        const epochStartDate = new Date(CHALLENGE_EPOCH_START_DATE_STRING);
        const periodMs = CHALLENGE_PERIOD_WEEKS * 7 * 24 * 60 * 60 * 1000;
        const now = new Date();

        if (now < epochStartDate) {
            // 챌린지 시작 전이면 첫 마감일 반환
            return new Date(epochStartDate.getTime() + periodMs);
        }
        const timeSinceEpochStart = now.getTime() - epochStartDate.getTime();
        const currentPeriodIndex = Math.floor(timeSinceEpochStart / periodMs);
        // 현재 챌린지의 마감일
        return new Date(epochStartDate.getTime() + (currentPeriodIndex + 1) * periodMs);
    }

    function updateChallengeCountdown() {
        if (!nextChallengeDayDisplay || !timeRemainingDisplay) return;

        // 마감일 하드코딩
        nextChallengeDayDisplay.textContent = `챌린지 마감 기한: 2025년 05월 25일 까지`;

        // 남은 시간도 하드코딩된 마감일 기준으로 계산
        const hardcodedDeadline = new Date('2025-05-25T00:00:00+09:00');
        const now = new Date();
        const timeLeft = hardcodedDeadline.getTime() - now.getTime();

        if (timeLeft <= 0) {
            timeRemainingDisplay.textContent = "(마감! 다음 주기를 기다려주세요)";
            if (countdownIntervalId) clearInterval(countdownIntervalId);
            return;
        }

        const days = Math.floor(timeLeft / (1000 * 60 * 60 * 24));
        const hours = Math.floor((timeLeft % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
        timeRemainingDisplay.textContent = `(${days}일 ${hours}시간 ${minutes}분 남음)`;
    }

    if (auth) { auth.onAuthStateChanged(function(user) {
        if (user) {
            if (loginForm) loginForm.style.display = 'none';
            if (userInfoDisplay) userInfoDisplay.style.display = 'block';
            if (userEmailDisplay) userEmailDisplay.textContent = `관리자: ${user.email}`;
            if (adminControls) adminControls.style.display = 'block';
        } else {
            if (loginForm) loginForm.style.display = 'block';
            if (userInfoDisplay) userInfoDisplay.style.display = 'none';
            if (adminControls) adminControls.style.display = 'none';
        }
    }); }
    else { console.error("Firebase Auth 객체 X"); }

    if (loginButton && loginEmailInput && loginPasswordInput && loginErrorMessage) {
        loginButton.addEventListener('click', function() {
            const email = loginEmailInput.value;
            const password = loginPasswordInput.value;
            if (!email || !password) {
                loginErrorMessage.textContent = '이메일과 비밀번호를 모두 입력해주세요.';
                loginErrorMessage.style.display = 'block'; return;
            }
            loginErrorMessage.style.display = 'none';
            auth.signInWithEmailAndPassword(email, password)
                .then((userCredential) => { console.log('Login successful:', userCredential.user.email); })
                .catch((error) => {
                    console.error('Login failed:', error);
                    loginErrorMessage.textContent = `로그인 실패: ${getFirebaseErrorMessage(error)}`;
                    loginErrorMessage.style.display = 'block';
                });
        });
    }
    if (logoutButton) { logoutButton.addEventListener('click', function() { auth.signOut().catch((error) => { console.error('Logout failed:', error); }); }); }

    function openModal() { if (addBlogModal) { addBlogModal.style.display = 'flex'; console.log('Add blog modal opened'); } }
    function closeModal() { if (addBlogModal) { addBlogModal.style.display = 'none'; if (addBlogForm) addBlogForm.reset(); console.log('Add blog modal closed');} }

    if (showAddBlogModalButton) showAddBlogModalButton.addEventListener('click', openModal);
    if (closeModalButton) closeModalButton.addEventListener('click', closeModal);
    if (cancelAddBlogButton) cancelAddBlogButton.addEventListener('click', closeModal);
    if (addBlogModal) addBlogModal.addEventListener('click', function(event) { if (event.target === addBlogModal) closeModal(); });

    if (addBlogForm) {
        addBlogForm.addEventListener('submit', async function(event) {
            event.preventDefault();
            const blogNameInput = document.getElementById('blog-name-input');
            const blogUrlInput = document.getElementById('blog-url-input');
            const rssFeedUrlInput = document.getElementById('rss-feed-url-input');

            if (!blogNameInput || !blogUrlInput || !rssFeedUrlInput) {
                alert('폼 입력 요소를 찾을 수 없습니다. HTML ID를 확인해주세요.'); return;
            }
            const blogName = blogNameInput.value.trim();
            const blogUrl = blogUrlInput.value.trim();
            const rssFeedUrl = rssFeedUrlInput.value.trim();
            if (!blogName || !blogUrl || !rssFeedUrl) { alert('모든 필드를 입력해주세요.'); return; }

            try {
                await db.collection('blogs').add({
                    name: blogName, url: blogUrl, rss_feed_url: rssFeedUrl,
                    rank: allFetchedBlogs.length + 1000, isActive: true,
                    challengePosts: 0,
                    lastPostDate: "",
                    posts: [], rssRegistered: true,
                    challengeSuccessCount: 0, challengeFailureCount: 0, specialMissionCompleted: false,
                    createdAt: firebase.firestore.FieldValue.serverTimestamp()
                });
                alert('블로그가 성공적으로 추가되었습니다!'); closeModal(); loadBlogsAndDisplay();
            } catch (error) {
                console.error("Error adding blog: ", error);
                alert('블로그 추가 중 오류가 발생했습니다: ' + error.message);
            }
        });
    }

    async function fetchAndUpdateSingleBlogRss(blogDocId) {
        // 이 함수는 사용자님의 기존 코드를 그대로 유지합니다.
        // (특별 과제, 일반 챌린지 구분 로직이 포함된, 정상 작동했던 최종본으로 가정)
        if (!blogDocId || blogDocId.trim() === "") { console.error("업데이트할 블로그 문서 ID 유효X"); alert("문서 ID 오류"); return; }
        let rssFeedUrlToFetch;
        try {
            const blogDoc = await db.collection('blogs').doc(blogDocId).get();
            if (!blogDoc.exists) throw new Error(`문서 없음 (ID: ${blogDocId})`);
            const blogData = blogDoc.data();
            if (!blogData) throw new Error(`데이터 없음 (ID: ${blogDocId})`);
            rssFeedUrlToFetch = blogData.rss_feed_url;
            if (!rssFeedUrlToFetch) throw new Error(`RSS URL 없음 (ID: ${blogDocId})`);
        } catch (error) { console.error("Firestore 정보 가져오기 오류:", error); alert(`Firestore 오류: ${error.message}`); return; }

        const apiUrl = `/api/fetch-rss?url=${encodeURIComponent(rssFeedUrlToFetch)}`;
        console.log(`Workspaceing RSS for ${blogDocId} from API: ${apiUrl}`);
        try {
            const response = await fetch(apiUrl);
            if (!response.ok) { const txt = await response.text(); throw new Error(`API 응답오류 ${response.status}: ${txt}`);}
            const data = await response.json();
            if (data.error) { throw new Error(`API 데이터 오류: ${data.details || data.error}`);}
            if (!data.items || data.items.length === 0) { alert('RSS 새 글 없음'); /* 오류기록 등 */ return; }

            const blogRef = db.collection('blogs').doc(blogDocId);
            const latestPost = data.items[0];
            const newLastPostDateToStore = latestPost.isoDate || latestPost.pubDate;
            let challengePostsCount = 0;
            data.items.forEach(item => {
                const postDateISO = item.isoDate || item.pubDate;
                if (postDateISO) {
                    const postDateObj = new Date(postDateISO);
                    if (!isNaN(postDateObj.getTime()) && postDateObj >= CHALLENGE_START_DATE_FOR_COUNTING_POSTS_UTC) {
                        challengePostsCount++;
                    }
                }
            });
            const processedPostsForFirestore = data.items.map(item => ({ title: item.title || "제목 없음", date: (item.isoDate || item.pubDate), link: item.link || "#", snippet: (item.contentSnippet || "").slice(0,150) + '...' })).slice(0,5);
            
            const updateData = {
                lastPostDate: newLastPostDateToStore,
                posts: processedPostsForFirestore,
                challengePosts: challengePostsCount,
                rssFetchError: null,
                lastRssFetchSuccessAt: firebase.firestore.FieldValue.serverTimestamp()
                // isActive, specialMissionCompleted, success/failureCount 등은
                // 전체 업데이트하는 서버리스 함수(/api/fetch-rss)에서 주로 담당합니다.
                // 이 버튼은 주로 최신 글 정보와 challengePosts를 빠르게 업데이트하는 용도입니다.
            };
            await blogRef.update(updateData);
            alert(`${data.feedTitle || blogDocId} 업데이트! (CP: ${challengePostsCount})`);
            loadBlogsAndDisplay();
        } catch (error) { console.error(`RSS 업데이트 오류 (${blogDocId}):`, error); alert(`RSS 업데이트 오류: ${error.message}`); /* 오류 기록 등 */ }
    }

    if (testUpdateRssButton) { testUpdateRssButton.addEventListener('click', function() {
        const TEST_BLOG_DOC_ID = "CCwkT8xc1zbTZdTrg1g6"; // 실제 ID로 변경 필요
        const PLACEHOLDER_ID_TEXT = "여기에_테스트할_블로그_문서ID_넣기";
        if (TEST_BLOG_DOC_ID === PLACEHOLDER_ID_TEXT || !TEST_BLOG_DOC_ID || TEST_BLOG_DOC_ID.trim() === "") {
             alert("TEST_BLOG_DOC_ID 변수 확인 필요"); return;
        }
        fetchAndUpdateSingleBlogRss(TEST_BLOG_DOC_ID);
    }); }
    else { console.warn("testUpdateRssButton not found."); }

    // --- !!!! 블로그 목록 및 대시보드 표시 함수 (기존 displayBlogList 수정) !!!! ---
    function displayBlogList(blogsToDisplay) {
        // 대시보드 관련 요소 확인
        if (!dashboardTbody) {
            console.warn('displayBlogList: 대시보드 tbody 요소를 찾을 수 없습니다! (dashboardTbody is null)');
        }
        // 상세 목록 관련 요소 확인
        if (!blogListElement || !emptyMessageElement) {
            console.error('displayBlogList: 상세 목록 ul 또는 empty 메시지 요소를 찾을 수 없습니다!');
            return; 
        }

        // 초기화
        if (dashboardTbody) dashboardTbody.innerHTML = ''; // 대시보드 내용 비우기
        blogListElement.innerHTML = ''; // 상세 목록 내용 비우기

        if (!blogsToDisplay || blogsToDisplay.length === 0) {
            if (dashboardTbody && dashboardEmptyMessage) {
                dashboardEmptyMessage.style.display = 'block';
                const pTagDash = dashboardEmptyMessage.querySelector('p');
                if (pTagDash) pTagDash.textContent = '표시할 블로그가 없습니다.';
                // dashboardTbody.style.display = 'none'; // tbody를 숨길 필요는 없음
            }
            if (emptyMessageElement) {
                emptyMessageElement.style.display = 'block';
                const pTagDetail = emptyMessageElement.querySelector('p');
                if (pTagDetail) pTagDetail.textContent = '표시할 블로그가 없습니다.';
            }
            blogListElement.style.display = 'none';
            return;
        }

        if (dashboardEmptyMessage) dashboardEmptyMessage.style.display = 'none';
        if (emptyMessageElement) emptyMessageElement.style.display = 'none';
        // if (dashboardTbody) dashboardTbody.style.display = ''; // 기본 display 따름
        blogListElement.style.display = 'block';


        blogsToDisplay.forEach(function(blog) {
            const successCount = blog.challengeSuccessCount === undefined ? 0 : blog.challengeSuccessCount;
            const failureCount = blog.challengeFailureCount === undefined ? 0 : blog.challengeFailureCount;

            // --- 1. 대시보드 테이블 행(row) 생성 ---
            if (dashboardTbody) { // dashboardTbody가 있을 때만 실행
                const tr = dashboardTbody.insertRow();

                const cellProfile = tr.insertCell();
                cellProfile.classList.add('col-profile');
                if (blog.profileImageUrl) {
                    cellProfile.innerHTML = `<img src="${blog.profileImageUrl}" alt="${blog.name || '프로필'}" class="dashboard-profile-img">`;
                } else { cellProfile.innerHTML = `<span class="dashboard-profile-img-placeholder"></span>`; }

                const cellName = tr.insertCell();
                cellName.classList.add('col-name');
                cellName.textContent = blog.name || '이름 없음';

                const cellSpecialMission = tr.insertCell();
                cellSpecialMission.classList.add('col-special-mission');
                const specialMissionText = blog.specialMissionCompleted ? '✔ 완료' : '✖ 미완료';
                const specialMissionClass = blog.specialMissionCompleted ? 'success' : 'fail';
                cellSpecialMission.innerHTML = `<span class="dashboard-status-text ${specialMissionClass}">${specialMissionText}</span>`;

                const cellCurrentStatus = tr.insertCell();
                cellCurrentStatus.classList.add('col-current-status');
                const currentStatusText = blog.isActive ? '● 성공' : '⚠ 진행 중';
                const currentStatusClass = blog.isActive ? 'success' : 'pending';
                cellCurrentStatus.innerHTML = `<span class="dashboard-status-text ${currentStatusClass}">${currentStatusText}</span>`;

                const cellCumulative = tr.insertCell();
                cellCumulative.classList.add('col-cumulative-record');
                cellCumulative.innerHTML = `<span class="dashboard-cumulative-text">(<strong class="success-count">🏆 ${successCount}</strong> / <strong class="failure-count">💔 ${failureCount}</strong>)</span>`;

                const cellTotalPosts = tr.insertCell();
                cellTotalPosts.classList.add('col-total-posts');
                cellTotalPosts.textContent = blog.challengePosts === undefined ? '?' : blog.challengePosts;

                const cellLastPostDate = tr.insertCell();
                cellLastPostDate.classList.add('col-last-post-date');
                cellLastPostDate.textContent = formatKoreanDate(blog.lastPostDate, true);

                const cellActions = tr.insertCell();
                cellActions.classList.add('col-actions');
                cellActions.innerHTML = `<a href="${blog.url || '#'}" target="_blank" rel="noopener noreferrer" class="button-visit-dashboard">방문</a>`;
            }

            // --- 2. 하단 상세 목록 아이템 생성 (사용자님의 기존 코드와 동일하게 유지) ---
            const listItem = document.createElement('li');
            const statusClassForDetail = blog.isActive ? 'active' : 'inactive';
            const statusTextForDetail = blog.isActive ? '챌린지 성공' : '챌린지 진행 중';
            const rssIconTextForDetail = blog.rssRegistered ? 'RSS 등록됨' : 'RSS 미등록';
            let recentPostsHTML = '<div class="blog-item-recent-posts"><strong>최신 포스팅</strong><ul>';
            if (blog.posts && blog.posts.length > 0) {
                blog.posts.slice(0, 3).forEach(post => {
                    const postTitle = post.title || '제목 없음';
                    const postLink = post.link || '#';
                    const formattedDate = formatKoreanDate(post.date, true);
                    const isVisited = visitedLinks[postLink];
                    const linkClass = isVisited ? 'visited-link' : '';
                    recentPostsHTML += `<li><a href="${postLink}" target="_blank" rel="noopener noreferrer" class="${linkClass}" data-link="${postLink}">${postTitle}</a> <span class="post-date">${formattedDate}</span></li>`;
                });
            } else { recentPostsHTML += '<li>최신 포스팅 정보가 없습니다.</li>'; }
            recentPostsHTML += '</ul></div>';

            const formattedLastPostDateForDetail = formatKoreanDate(blog.lastPostDate, true);
            const specialMissionDisplayForDetail = blog.specialMissionCompleted ? '🌟 특별과제 완료!' : '⏳ 특별과제 미완료';
            const specialMissionCssClassForDetail = blog.specialMissionCompleted ? 'special-mission-success' : 'special-mission-pending';

            listItem.innerHTML = `
            ${'' /* <span class="blog-item-rank">${blog.rank === undefined ? '?' : blog.rank}</span> */}
            <div class="blog-item-main">
                <div class="blog-item-header">
                    ${blog.profileImageUrl ? `<img src="${blog.profileImageUrl}" alt="${blog.name}" class="blog-profile-image">` : '<span class="blog-profile-image-placeholder"></span>'}
                    <div class="blog-item-title">${blog.name || '이름 없음'}</div>
                    <div class="blog-status-wrapper">
                        <span class="challenge-counts-inline" style="font-size: 0.85em; color: #333; margin-right: 8px; white-space: nowrap;">
                            (성공: <strong style="color: green;">${successCount}</strong> / 실패: <strong style="color: red;">${failureCount}</strong>)
                        </span>
                        <span class="blog-item-status ${statusClassForDetail}">${statusTextForDetail}</span>
                    </div>
                </div>
                <div class="blog-item-url">
                    <a href="${blog.url || '#'}" target="_blank" rel="noopener noreferrer">${blog.url || '주소 없음'}</a>
                </div>
                <div class="special-mission-status ${specialMissionCssClassForDetail}">
                    ${specialMissionDisplayForDetail}
                </div>
                <div class="blog-item-stats">
                    <span><strong>최근 포스팅</strong>: ${formattedLastPostDateForDetail}</span>
                    <span class="challenge-post-count"><strong>챌린지 포스팅</strong>: ${blog.challengePosts === undefined ? '?' : blog.challengePosts}</span>
                </div>
                ${recentPostsHTML}
                <div class="blog-item-meta">
                    <span class="rss-status">${rssIconTextForDetail}</span>
                    <span class="visit-link"><a href="${blog.url || '#'}" target="_blank" rel="noopener noreferrer">방문하기</a></span>
                </div>
            </div>
        `;
            // blogListElement는 사용자 코드에서 이 이름으로 사용 중
            if (blogListElement) blogListElement.appendChild(listItem);
        });
        addVisitedLinkListener();
    }

    function addVisitedLinkListener()  {
        const postLinks = document.querySelectorAll('.blog-item-recent-posts a');
        postLinks.forEach(link => {
            const linkUrl = link.dataset.link;
            if (linkUrl && visitedLinks[linkUrl]) link.classList.add('visited-link');
            link.addEventListener('click', function() {
                const clickedUrl = this.dataset.link;
                if (clickedUrl) {
                    visitedLinks[clickedUrl] = true;
                    localStorage.setItem('visitedBlogPosts', JSON.stringify(visitedLinks));
                    this.classList.add('visited-link');
                }
            });
        });
    }

    function updateSummary(total, activeCount, inactiveCount)  { // 파라미터 이름 유지 (내부 로직이 isActive 기준)
        if (totalBlogsValueElement) totalBlogsValueElement.textContent = total;
        if (activeBlogsValueElement) activeBlogsValueElement.textContent = activeCount; // "챌린지 성공" 수
        if (inactiveBlogsValueElement) inactiveBlogsValueElement.textContent = inactiveCount; // "챌린지 진행 중" 수
    }

    function applyFiltersAndSort() {
        // 필터/정렬 요소가 없으면 전체 목록을 기본 정렬(최신 포스팅 순)으로 표시
        if (!statusFilterElement || !sortOrderElement) {
            let blogsToRender = [...allFetchedBlogs];
            // 기본 정렬: 최근 포스팅 순
            blogsToRender.sort((a, b) => {
                const dateA = new Date(a.lastPostDate || 0); // Firestore에 저장된 표준 형식 날짜
                const dateB = new Date(b.lastPostDate || 0);
                if (isNaN(dateA.getTime()) && isNaN(dateB.getTime())) return 0;
                if (isNaN(dateA.getTime())) return 1; // 유효하지 않은 날짜는 뒤로
                if (isNaN(dateB.getTime())) return -1;
                return dateB - dateA; // 내림차순 (최신이 위로)
            });
            renderDashboardTable(blogsToRender);
            displayBlogList(blogsToRender);
            return;
        }
        const statusFilterValue = statusFilterElement.value;
        const sortOrderValue = sortOrderElement.value; // 이제 "recent_post" 또는 "post_count_desc"
        let filteredAndSortedBlogs = [...allFetchedBlogs];

        if (statusFilterValue === 'active') { filteredAndSortedBlogs = filteredAndSortedBlogs.filter(blog => blog.isActive === true); }
        else if (statusFilterValue === 'inactive') { filteredAndSortedBlogs = filteredAndSortedBlogs.filter(blog => blog.isActive === false); }    
        if (sortOrderValue === 'post_count_desc') { // "포스팅 많은 순"
            filteredAndSortedBlogs.sort((a, b) => (b.challengePosts || 0) - (a.challengePosts || 0));
        } else if (sortOrderValue === 'recent_post') { // "최근 포스팅 순"
            filteredAndSortedBlogs.sort((a, b) => {
                const dateA = new Date(a.lastPostDate || 0); // Firestore에 저장된 표준 형식 날짜 사용
                const dateB = new Date(b.lastPostDate || 0);
                if (isNaN(dateA.getTime()) && isNaN(dateB.getTime())) return 0;
                if (isNaN(dateA.getTime())) return 1;
                if (isNaN(dateB.getTime())) return -1;
                return dateB - dateA; // 내림차순 (최신 날짜가 먼저 오도록)
            });
        }
        
        displayBlogList(filteredAndSortedBlogs); // 기존 displayBlogList 호출 유지
        // 만약 renderDashboardTable 함수를 별도로 만들었다면 여기서도 호출
        // renderDashboardTable(filteredAndSortedBlogs);
    }

    async function loadBlogsAndDisplay() {
        // 대시보드 관련 empty 메시지 처리 추가
        if (!blogListElement || !emptyMessageElement || !dashboardTbody || !dashboardEmptyMessage) {
            console.error('Initial load: 필수 HTML 요소가 없습니다. HTML ID를 확인해주세요.'); return;
        }
        if(dashboardTbody) dashboardTbody.innerHTML = '';
        if(blogListElement) blogListElement.innerHTML = ''; // 기존 이름 사용
        if(dashboardEmptyMessage) {dashboardEmptyMessage.style.display = 'block'; const p=dashboardEmptyMessage.querySelector('p'); if(p)p.textContent='블로그 데이터를 불러오는 중...';}
        if(emptyMessageElement) {emptyMessageElement.style.display = 'block'; const p=emptyMessageElement.querySelector('p'); if(p)p.textContent='블로그 데이터를 불러오는 중...';} // 기존 이름 사용
        updateSummary('?', '?', '?');
        try {
            const snapshot = await db.collection('blogs').orderBy('rank', 'asc').get();
            allFetchedBlogs = [];
            if (snapshot.empty) { console.log('No blogs in Firestore.'); }
            else { snapshot.forEach(doc => { allFetchedBlogs.push({ id: doc.id, ...doc.data() }); }); }
            let activeCount = 0;
            allFetchedBlogs.forEach(blog => { if (blog.isActive) activeCount++; });
            updateSummary(allFetchedBlogs.length, activeCount, allFetchedBlogs.length - activeCount);
            applyFiltersAndSort();
        } catch (error) {
            console.error("Error fetching blogs: ", error);
            const pDash = dashboardEmptyMessage ? dashboardEmptyMessage.querySelector('p') : null;
            const pDetail = emptyMessageElement ? emptyMessageElement.querySelector('p') : null; // 기존 이름 사용
            if(pDash) pDash.textContent = '데이터를 불러오는 데 실패했습니다.';
            if(pDetail) pDetail.textContent = '데이터를 불러오는 데 실패했습니다.';
            updateSummary('X', 'X', 'X');
            allFetchedBlogs = [];
            displayBlogList(allFetchedBlogs); // 기존 이름 사용 (이 함수가 이제 대시보드도 처리)
        }
    }

    function getFirebaseErrorMessage(error) { /* ... 이전과 동일 ... */ }

    if (statusFilterElement) { statusFilterElement.addEventListener('change', applyFiltersAndSort); }
    else { console.warn("statusFilterElement not found."); }
    if (sortOrderElement) { sortOrderElement.addEventListener('change', applyFiltersAndSort); }
    else { console.warn("sortOrderElement not found."); }
    if (refreshButton) {
        refreshButton.addEventListener('click', function() {
            console.log('새로고침 버튼 클릭됨');
            loadBlogsAndDisplay();
        });
    } else { console.warn("refreshButton not found."); }

    loadBlogsAndDisplay();
    if (nextChallengeDayDisplay && timeRemainingDisplay) {
        updateChallengeCountdown();
        if (countdownIntervalId) clearInterval(countdownIntervalId);
        countdownIntervalId = setInterval(updateChallengeCountdown, 60000);
    } else {
        console.warn("Challenge countdown display elements not found.");
    }

});
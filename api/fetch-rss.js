// api/fetch-rss.js

const Parser = require('rss-parser');
const parser = new Parser({ timeout: 10000, headers: {'User-Agent': 'BlogChallengeBot/1.0'} });
const admin = require('firebase-admin');

// Firebase Admin SDK 초기화
try {
    if (!admin.apps.length) {
        const serviceAccountString = process.env.FIREBASE_SERVICE_ACCOUNT_KEY_JSON;
        if (!serviceAccountString) {
            console.error("Firebase 서비스 계정 키 환경 변수가 설정되지 않았습니다. 함수가 제대로 작동하지 않을 수 있습니다.");
        } else {
            const serviceAccount = JSON.parse(serviceAccountString);
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
            console.log("Firebase Admin SDK 초기화 성공");
        }
    }
} catch (e) {
    console.error('Firebase Admin SDK 초기화 실패:', e.message);
}

const CHALLENGE_EPOCH_START_DATE_STRING = '2025-05-10T00:00:00Z'; // 챌린지 대주기 시작일 (UTC)
const CHALLENGE_PERIOD_MS = 14 * 24 * 60 * 60 * 1000; // 2주를 밀리초로

// 특별 과제 기간 정의 (UTC 기준)
const SPECIAL_MISSION_START_DATE_STRING = '2025-05-10T00:00:00Z';
const SPECIAL_MISSION_END_DATE_STRING = '2025-05-12T23:59:59Z'; // 12일 마지막 순간까지 (UTC)

function isValidDate(dateString) {
    if (!dateString) return false;
    const date = new Date(dateString);
    return !isNaN(date.getTime());
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(200).end();

    if (!admin.apps.length) {
        console.error('Firebase Admin SDK가 초기화되지 않아 함수를 실행할 수 없습니다.');
        return res.status(500).json({ error: '서버 내부 오류: Firebase 설정 문제' });
    }
    const db = admin.firestore();

    console.log('모든 블로그 정보 업데이트 시작 (특별 과제 로직 포함)...');
    let successfulRssUpdates = 0;
    let failedRssUpdates = 0;
    const blogsDataForRanking = [];

    try {
        const blogsRef = db.collection('blogs');
        const blogsSnapshot = await blogsRef.get();

        if (blogsSnapshot.empty) {
            return res.status(200).json({ message: '등록된 블로그 없음', updatedCount: 0, errorCount: 0 });
        }

        const epochStartDate = new Date(CHALLENGE_EPOCH_START_DATE_STRING);
        const now = new Date();
        const specialMissionStartDate = new Date(SPECIAL_MISSION_START_DATE_STRING);
        const specialMissionEndDate = new Date(SPECIAL_MISSION_END_DATE_STRING);

        const blogProcessingPromises = blogsSnapshot.docs.map(async (doc) => {
            const blogData = doc.data();
            const blogId = doc.id;
            const blogName = blogData.name || blogId;
            const rssUrl = blogData.rss_feed_url;
            let writeOperations = {};
            
            // Firestore의 현재 값을 기준으로 final 변수들 초기화
            let finalChallengePosts = blogData.challengePosts || 0;
            let finalIsActive = blogData.isActive === undefined ? false : blogData.isActive;
            let finalSuccessCount = blogData.challengeSuccessCount || 0;
            let finalFailureCount = blogData.challengeFailureCount || 0;
            let finalSpecialMissionCompleted = blogData.specialMissionCompleted || false;

            if (!rssUrl) {
                console.warn(`블로그 [${blogName}] RSS URL 없음.`);
                failedRssUpdates++;
                try { await blogsRef.doc(blogId).update({ rssFetchError: 'RSS URL 없음', lastRssFetchAttemptAt: admin.firestore.FieldValue.serverTimestamp() }); }
                catch (err) { console.error(`[${blogId}] Firestore 오류 기록 실패 (RSS URL 없음):`, err.message); }
                blogsDataForRanking.push({ id: blogId, name: blogName, challengePosts: finalChallengePosts, isActive: finalIsActive, challengeSuccessCount: finalSuccessCount, challengeFailureCount: finalFailureCount, specialMissionCompleted: finalSpecialMissionCompleted });
                return;
            }

            console.log(`[${blogName}] 처리 시작: ${rssUrl}`);
            try {
                const feed = await parser.parseURL(rssUrl);
                console.log(`[${blogName}] RSS 가져오기 성공: ${feed.title}`);
                writeOperations = {};

                if (!feed.items || feed.items.length === 0) {
                    writeOperations.rssFetchError = '피드에 아이템 없음';
                    finalIsActive = false; // 피드에 글 없으면 현재 기간 일반 챌린지 실패로 간주
                    writeOperations.isActive = finalIsActive;
                    writeOperations.lastRssFetchAttemptAt = admin.firestore.FieldValue.serverTimestamp();
                } else {
                    let calculatedGeneralChallengePosts = 0;
                    let latestPostDateObjInFeed = null;
                    const postsForGeneralChallenge = [];
                    let achievedSpecialMissionInThisFeed = finalSpecialMissionCompleted; // 기존 값 또는 false로 시작

                    feed.items.forEach(item => {
                        const postDateISO = item.isoDate || item.pubDate;
                        if (isValidDate(postDateISO)) {
                            const postDateObj = new Date(postDateISO);
                            if (!latestPostDateObjInFeed || postDateObj > latestPostDateObjInFeed) {
                                latestPostDateObjInFeed = postDateObj;
                            }

                            // 특별 과제 기간 체크
                            if (postDateObj >= specialMissionStartDate && postDateObj <= specialMissionEndDate) {
                                if (!achievedSpecialMissionInThisFeed) { // 아직 달성 안했을 때만 로그 남김
                                     console.log(`[${blogName}] 특별 과제 기간 내 포스팅 발견: ${postDateISO}`);
                                }
                                achievedSpecialMissionInThisFeed = true;
                                // 이 글은 일반 챌린지 카운트에 포함하지 않음
                            } else if (postDateObj >= epochStartDate) { // 특별 과제 기간이 아니면서, 챌린지 시작일 이후
                                calculatedGeneralChallengePosts++;
                                postsForGeneralChallenge.push(postDateObj);
                            }
                        }
                    });
                    // console.log(`[${blogName}] postsForGeneralChallenge:`, postsForGeneralChallenge.map(d => d.toISOString())); // 디버깅용

                    finalChallengePosts = calculatedGeneralChallengePosts; // 일반 챌린지 포스팅 수로 확정
                    finalSpecialMissionCompleted = achievedSpecialMissionInThisFeed;

                    writeOperations.lastPostDate = latestPostDateObjInFeed ? latestPostDateObjInFeed.toISOString() : (blogData.lastPostDate || "");
                    writeOperations.posts = feed.items.slice(0, 5).map(item => ({
                        title: item.title || "제목 없음", link: item.link || "#",
                        date: item.isoDate || item.pubDate || "", // 표준 형식 저장
                        snippet: item.contentSnippet ? item.contentSnippet.slice(0, 150) + '...' : ''
                    }));
                    writeOperations.challengePosts = finalChallengePosts;
                    writeOperations.specialMissionCompleted = finalSpecialMissionCompleted;
                    writeOperations.rssFetchError = null;
                    writeOperations.lastRssFetchSuccessAt = admin.firestore.FieldValue.serverTimestamp();

                    // --- 일반 챌린지 기간별 성공/실패 누적 (postsForGeneralChallenge 사용) ---
                    let successCount = blogData.challengeSuccessCount || 0;
                    let failureCount = blogData.challengeFailureCount || 0;
                    let lastProcessed = blogData.lastProcessedPeriodEndDate ? new Date(blogData.lastProcessedPeriodEndDate) : null;
                    let periodIteratorStart = lastProcessed ? new Date(lastProcessed.getTime() + 1) : new Date(epochStartDate.getTime());

                    while (periodIteratorStart < now) {
                        const periodIteratorEnd = new Date(periodIteratorStart.getTime() + CHALLENGE_PERIOD_MS - 1);
                        if (periodIteratorEnd >= now) break;
                        let postedThisPeriod = false;
                        for (const postDate of postsForGeneralChallenge) { // !!!! 일반 챌린지 글만으로 판단 !!!!
                            if (postDate >= periodIteratorStart && postDate <= periodIteratorEnd) {
                                postedThisPeriod = true; break;
                            }
                        }
                        if (postedThisPeriod) successCount++; else failureCount++;
                        lastProcessed = periodIteratorEnd;
                        periodIteratorStart = new Date(lastProcessed.getTime() + 1);
                    }
                    writeOperations.challengeSuccessCount = successCount;
                    writeOperations.challengeFailureCount = failureCount;
                    if (lastProcessed) writeOperations.lastProcessedPeriodEndDate = lastProcessed.toISOString();
                    
                    finalSuccessCount = successCount;
                    finalFailureCount = failureCount;

                    // --- 현재 2주차 일반 챌린지 성공 여부 (isActive) 판정 (postsForGeneralChallenge 사용) ---
                    const currentPeriodSlotStart = new Date(epochStartDate.getTime() + Math.floor((now.getTime() - epochStartDate.getTime()) / CHALLENGE_PERIOD_MS) * CHALLENGE_PERIOD_MS);
                    let currentPeriodHasGeneralPost = false;
                    for (const postDate of postsForGeneralChallenge) { // !!!! 일반 챌린지 글만으로 판단 !!!!
                        if (postDate >= currentPeriodSlotStart && postDate <= now) {
                            currentPeriodHasGeneralPost = true; break;
                        }
                    }
                    finalIsActive = currentPeriodHasGeneralPost; // !!!! 이것이 현재 기간 "일반 챌린지" 성공 여부 !!!!
                    writeOperations.isActive = finalIsActive;

                    // !!!! "첫 2주차 일반 챌린지 성공 시 누적 카운트 +1" 로직 !!!!
                    // 이 로직은 "완료된 기간"에 대한 누적(successCount)과는 별개로,
                    // 만약 *이번이 첫 번째 2주 기간이고*, *아직 그 기간이 완료되지 않았지만*,
                    // *현재까지의 "일반 챌린지" 포스팅으로 인해 finalIsActive가 true*가 되었다면,
                    // 그리고 *기존 누적 성공/실패가 모두 0이라면* (정말 첫 성공이라면)
                    // 임시로 successCount를 1로 설정하여 즉시 반영되도록 합니다.
                    // (기간이 완료되어 while 루프가 돌면 이 값은 다시 계산되어 덮어쓰여질 수 있습니다.)
                    if (!blogData.lastProcessedPeriodEndDate && // 아직 어떤 2주 기간도 "완료" 평가된 적이 없고
                        finalIsActive &&                         // 현재 기간 "일반 챌린지" 포스팅으로 성공 상태이며
                        successCount === 0 &&                    // 기존 누적 성공이 없고 (이전 기간 성공 없음)
                        failureCount === 0) {                    // 기존 누적 실패가 없다면
                        
                        // 이 조건은, 현재가 챌린지 시작 후 첫 2주 기간이고,
                        // 그 기간 내에 "일반 챌린지 글"을 써서 "현재 기간 성공(finalIsActive)"이 되었을 때 해당.
                        writeOperations.challengeSuccessCount = 1;
                        finalSuccessCount = 1; // blogsDataForRanking 에도 반영
                        console.log(`[${blogName}] 첫 2주차 '일반 챌린지', 현재 기간 포스팅 확인되어 successCount=1 임시 설정`);
                    }
                }

                if (Object.keys(writeOperations).length > 0) {
                    await blogsRef.doc(blogId).update(writeOperations);
                    console.log(`[${blogName}] Firestore 업데이트. CP:${finalChallengePosts}, Special:${finalSpecialMissionCompleted}, Active:${finalIsActive}, S:${writeOperations.challengeSuccessCount !== undefined ? writeOperations.challengeSuccessCount : finalSuccessCount}, F:${writeOperations.challengeFailureCount !== undefined ? writeOperations.challengeFailureCount : finalFailureCount}`);
                } else {
                    console.log(`[${blogName}] 업데이트할 새로운 RSS 정보 없음.`);
                }
                successfulRssUpdates++;

            } catch (error) {
                console.error(`[${blogName}] RSS 처리 오류:`, error.message);
                failedRssUpdates++;
                try { await blogsRef.doc(blogId).update({ rssFetchError: error.message.substring(0, 200), lastRssFetchAttemptAt: admin.firestore.FieldValue.serverTimestamp() }); }
                catch (errInner) { console.error(`[${blogId}] Firestore 오류 기록 실패:`, errInner.message); }
            }
            blogsDataForRanking.push({ id: blogId, name: blogName, challengePosts: finalChallengePosts, isActive: finalIsActive, challengeSuccessCount: finalSuccessCount, challengeFailureCount: finalFailureCount, specialMissionCompleted: finalSpecialMissionCompleted });
        });

        await Promise.all(blogProcessingPromises);
        console.log('모든 블로그 RSS 피드 처리 완료.');

        console.log('블로그 순위 재계산 시작...');
        if (blogsDataForRanking.length > 0) {
            blogsDataForRanking.sort((a, b) => (b.challengePosts || 0) - (a.challengePosts || 0));
            const rankUpdatePromises = blogsDataForRanking.map((blog, index) => {
                const rank = index + 1;
                if (!blog.id) { console.error('Rank update: blog.id is undefined', blog); return Promise.resolve(); }
                return blogsRef.doc(blog.id).update({ rank: rank })
                    .catch(err => { console.error(`[${blog.id}] 순위 업데이트 실패:`, err.message); return Promise.resolve(); });
            });
            await Promise.all(rankUpdatePromises);
            console.log('블로그 순위 재계산 및 업데이트 완료.');
        } else { console.log('순위를 계산할 블로그 데이터가 없습니다.'); }

        const finalResponseObject = {
            message: `모든 업데이트 완료. RSS 성공: ${successfulRssUpdates}, RSS 실패: ${failedRssUpdates}`,
            updatedCount: successfulRssUpdates,
            errorCount: failedRssUpdates
        };
        console.log('Sending final success response object:', JSON.stringify(finalResponseObject, null, 2));
        return res.status(200).json(finalResponseObject);

    } catch (finalError) {
        console.error('전체 RSS 업데이트 프로세스 중 심각한 오류 발생:', finalError);
        const errorResponseObject = {
            error: '전체 RSS 업데이트 프로세스 중 심각한 오류 발생',
            details: String(finalError.message),
            updatedCount: successfulRssUpdates,
            errorCount: failedRssUpdates
        };
        console.log('Sending final error response object:', JSON.stringify(errorResponseObject, null, 2));
        return res.status(500).json(errorResponseObject);
    }
};
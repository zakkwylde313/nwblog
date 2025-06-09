const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const Parser = require('rss-parser');
const parser = new Parser();
const fs = require('fs');
const path = require('path');

// Firebase Admin SDK 초기화
if (!admin.apps.length) {
    try {
        // Vercel 환경 변수에서 서비스 계정 정보 가져오기
        const serviceAccountKeyJson = process.env.FIREBASE_SERVICE_ACCOUNT_KEY_JSON;
        if (!serviceAccountKeyJson) {
            throw new Error('FIREBASE_SERVICE_ACCOUNT_KEY_JSON 환경 변수가 설정되지 않았습니다.');
        }

        const serviceAccount = JSON.parse(serviceAccountKeyJson);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log('Firebase Admin SDK 초기화 성공');
    } catch (error) {
        console.error('Firebase Admin SDK 초기화 실패:', error);
        throw error; // 오류를 상위로 전파하여 API 응답에서 처리할 수 있도록 함
    }
}

const app = express();
app.use(cors());
app.use(express.json());

const CHALLENGE_EPOCH_START_DATE_STRING = '2025-05-10T00:00:00+09:00'; // 챌린지 대주기 시작일 (KST)

const FIRST_CHALLENGE_START_KST = '2025-05-10T00:00:00+09:00';
const FIRST_CHALLENGE_END_KST = '2025-05-24T23:59:59.999+09:00'; // 1차: 15일 기간

const REGULAR_CHALLENGE_EPOCH_START_KST = '2025-05-25T00:00:00+09:00'; // 2차 챌린지 시작일이자, 일반 2주 주기의 기준일
const REGULAR_CHALLENGE_PERIOD_MS = 14 * 24 * 60 * 60 * 1000; // 일반 챌린지 기간: 2주 (14일)

function isValidDate(dateString) {
    if (!dateString) return false;
    const date = new Date(dateString);
    return !isNaN(date.getTime());
}

// 현재 챌린지 기간의 시작일과 종료일을 계산하는 함수
function calculateCurrentChallengePeriod() {
    const nowUtc = new Date(); // 현재 UTC 시간

    const firstChallengeStartDateUtc = new Date(FIRST_CHALLENGE_START_KST);
    const firstChallengeEndDateUtc = new Date(FIRST_CHALLENGE_END_KST);
    const regularChallengeEpochStartDateUtc = new Date(REGULAR_CHALLENGE_EPOCH_START_KST);

    let calculatedStartUtc;
    let calculatedEndUtc;

    if (nowUtc < firstChallengeStartDateUtc) {
        // 챌린지 시작 전: 첫 번째 챌린지 기간 정보를 기준으로 설정
        calculatedStartUtc = firstChallengeStartDateUtc;
        calculatedEndUtc = firstChallengeEndDateUtc;
    } else if (nowUtc <= firstChallengeEndDateUtc) {
        // 1차 챌린지 기간 중
        calculatedStartUtc = firstChallengeStartDateUtc;
        calculatedEndUtc = firstChallengeEndDateUtc;
    } else {
        // 2차 챌린지 기간 또는 그 이후 (nowUtc > firstChallengeEndDateUtc 이고, 
        // regularChallengeEpochStartDateUtc 이후여야 함)
        const timeSinceRegularEpoch = nowUtc.getTime() - regularChallengeEpochStartDateUtc.getTime();
        
        // currentPeriodIndex는 0부터 시작 (0은 2차 챌린지 기간을 의미)
        const currentPeriodIndex = Math.floor(timeSinceRegularEpoch / REGULAR_CHALLENGE_PERIOD_MS);

        calculatedStartUtc = new Date(regularChallengeEpochStartDateUtc.getTime() + (currentPeriodIndex * REGULAR_CHALLENGE_PERIOD_MS));
        calculatedEndUtc = new Date(calculatedStartUtc.getTime() + REGULAR_CHALLENGE_PERIOD_MS - 1);
    }
    
    const isCurrentPeriod = nowUtc >= calculatedStartUtc && nowUtc <= calculatedEndUtc;

    return {
        currentPeriodStart: calculatedStartUtc, // UTC Date 객체
        currentPeriodEnd: calculatedEndUtc,     // UTC Date 객체
        isCurrentPeriod
    };
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Content-Type', 'application/json');  // JSON 응답임을 명시
    if (req.method === 'OPTIONS') return res.status(200).end();

    if (!admin.apps.length) {
        console.error('Firebase Admin SDK가 초기화되지 않아 함수를 실행할 수 없습니다.');
        return res.status(500).json({ error: '서버 내부 오류: Firebase 설정 문제' });
    }
    const db = admin.firestore();

    // URL 파라미터에서 RSS URL 가져오기
    const rssUrlParam = req.query.url;
    if (rssUrlParam) {
        // 단일 블로그 RSS 가져오기
        try {
            console.log(`단일 블로그 RSS 가져오기 시작: ${rssUrlParam}`);
            const feed = await parser.parseURL(rssUrlParam);
            console.log(`RSS 가져오기 성공: ${feed.title}`);

            if (!feed.items || feed.items.length === 0) {
                return res.status(200).json({ error: '피드에 아이템 없음' });
            }

            // 날짜순으로 정렬 (최신순)
            const sortedItems = feed.items.sort((a, b) => {
                const dateA = new Date(a.isoDate || a.pubDate);
                const dateB = new Date(b.isoDate || b.pubDate);
                return dateB - dateA;
            });

            return res.status(200).json({
                feedTitle: feed.title,
                items: sortedItems.map(item => ({
                    title: item.title || "제목 없음",
                    link: item.link || "#",
                    date: item.isoDate || item.pubDate || "",
                    snippet: item.contentSnippet ? item.contentSnippet.slice(0, 150) + '...' : ''
                }))
            });
        } catch (error) {
            console.error('RSS 가져오기 오류:', error);
            return res.status(500).json({ error: 'RSS 가져오기 실패', details: error.message });
        }
    }

    // 전체 블로그 업데이트 로직
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
            let finalSpecialMissionCompleted = true; // 모든 블로그의 특별 과제를 완료 상태로 설정

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
                    finalIsActive = false;
                    writeOperations.isActive = finalIsActive;
                    writeOperations.lastRssFetchAttemptAt = admin.firestore.FieldValue.serverTimestamp();
                } else {
                    // 포스팅 날짜순으로 정렬 (최신순)
                    const sortedItems = feed.items.sort((a, b) => {
                        const dateA = new Date(a.isoDate || a.pubDate);
                        const dateB = new Date(b.isoDate || b.pubDate);
                        return dateB - dateA;
                    });

                    let calculatedGeneralChallengePosts = 0;
                    let latestPostDateObjInFeed = null;
                    const postsForGeneralChallenge = [];
                    const isBupyeongCampus = blogName.includes('부천범박');
                    let hasPostInCurrentPeriod = false;
                    console.log(`[${blogName}] RSS 피드 아이템 수: ${feed.items ? feed.items.length : 0}`);

                    // 현재 챌린지 기간 계산 (UTC 기준)
                    const { currentPeriodStart, currentPeriodEnd, isCurrentPeriod } = calculateCurrentChallengePeriod();
                    
                    // 챌린지 시작일 이후의 포스팅만 필터링
                    const challengeStartDate = new Date(CHALLENGE_EPOCH_START_DATE_STRING);
                    const challengePosts = sortedItems.filter(item => {
                        const postDateUtc = new Date(item.isoDate || item.pubDate);
                        return postDateUtc >= challengeStartDate;
                    });

                    // 필터링된 포스팅들을 날짜순으로 정렬 (오래된 순)
                    challengePosts.sort((a, b) => {
                        const dateA = new Date(a.isoDate || a.pubDate);
                        const dateB = new Date(b.isoDate || b.pubDate);
                        return dateA - dateB;
                    });

                    let firstPostFound = false; // 첫 포스팅 발견 여부
                    let secondPostFound = false; // 두 번째 포스팅 발견 여부 (부천범박용)

                    challengePosts.forEach((item, index) => {
                        const postDateISO = item.isoDate || item.pubDate;
                        if (!isValidDate(postDateISO)) {
                            console.log(`[${blogName}] 유효하지 않은 날짜 발견 (${index}번째 아이템): ${postDateISO}`);
                            return;
                        }
                        const postDateUtc = new Date(postDateISO);
                    
                        if (!latestPostDateObjInFeed || postDateUtc > latestPostDateObjInFeed) {
                            latestPostDateObjInFeed = postDateUtc;
                        }
                    
                        // 현재 챌린지 기간에 포스팅이 있는지 체크 (모두 UTC로 비교)
                        if (postDateUtc >= currentPeriodStart && postDateUtc <= currentPeriodEnd) {
                            hasPostInCurrentPeriod = true;
                        }
                    
                        if (!firstPostFound) {
                            firstPostFound = true;
                            return; 
                        }

                        if (isBupyeongCampus && !secondPostFound) {
                            secondPostFound = true;
                            return; 
                        }

                        calculatedGeneralChallengePosts++;
                        postsForGeneralChallenge.push(postDateUtc);
                    });

                    finalChallengePosts = calculatedGeneralChallengePosts;
                    
                    // =================================================================
                    // !!!! 수정된 부분 !!!!
                    // Firestore에 저장하는 `lastPostDate`는 UTC 시간 그대로 저장합니다.
                    // 불필요한 시간 변환 함수(kstToUTC)를 제거했습니다.
                    // =================================================================
                    writeOperations.lastPostDate = latestPostDateObjInFeed ? latestPostDateObjInFeed.toISOString() : (blogData.lastPostDate || "");
                    
                    writeOperations.posts = feed.items.slice(0, 5).map(item => ({
                        title: item.title || "제목 없음", 
                        link: item.link || "#",
                        date: item.isoDate || item.pubDate || "",
                        snippet: item.contentSnippet ? item.contentSnippet.slice(0, 150) + '...' : ''
                    }));
                    writeOperations.challengePosts = finalChallengePosts;
                    writeOperations.specialMissionCompleted = finalSpecialMissionCompleted;
                    writeOperations.rssFetchError = null;
                    writeOperations.lastRssFetchSuccessAt = admin.firestore.FieldValue.serverTimestamp();
                    
                    let successCount = blogData.challengeSuccessCount || 0;
                    let failureCount = blogData.challengeFailureCount || 0;
                    let lastProcessedPeriodEndDateUtc = blogData.lastProcessedPeriodEndDate ? new Date(blogData.lastProcessedPeriodEndDate) : null;

                    const overallChallengeProgramStartUtc = new Date(FIRST_CHALLENGE_START_KST);
                    const firstChallengeActualEndUtc = new Date(FIRST_CHALLENGE_END_KST);
                    const regularPeriodsActualStartUtc = new Date(REGULAR_CHALLENGE_EPOCH_START_KST);
                    const nowForLoop = new Date();

                    let nextPeriodToProcessStartUtc = lastProcessedPeriodEndDateUtc ? new Date(lastProcessedPeriodEndDateUtc.getTime() + 1) : overallChallengeProgramStartUtc;

                    if (nextPeriodToProcessStartUtc <= firstChallengeActualEndUtc && firstChallengeActualEndUtc < nowForLoop) {
                        let postedInFirstPeriod = postsForGeneralChallenge.some(postDate => postDate >= overallChallengeProgramStartUtc && postDate <= firstChallengeActualEndUtc);
                        if (postedInFirstPeriod) successCount++; else failureCount++;
                        lastProcessedPeriodEndDateUtc = firstChallengeActualEndUtc;
                        nextPeriodToProcessStartUtc = new Date(lastProcessedPeriodEndDateUtc.getTime() + 1);
                    }

                    if (nextPeriodToProcessStartUtc < regularPeriodsActualStartUtc) {
                        nextPeriodToProcessStartUtc = regularPeriodsActualStartUtc;
                    }

                    let currentRegularPeriodStartUtc = nextPeriodToProcessStartUtc;
                    while (currentRegularPeriodStartUtc < nowForLoop && currentRegularPeriodStartUtc >= regularPeriodsActualStartUtc) {
                        const currentRegularPeriodEndUtc = new Date(currentRegularPeriodStartUtc.getTime() + REGULAR_CHALLENGE_PERIOD_MS - 1);

                        if (currentRegularPeriodEndUtc >= nowForLoop) break;

                        let postedThisRegularPeriod = postsForGeneralChallenge.some(postDate => postDate >= currentRegularPeriodStartUtc && postDate <= currentRegularPeriodEndUtc);
                        if (postedThisRegularPeriod) successCount++; else failureCount++;
                        
                        lastProcessedPeriodEndDateUtc = currentRegularPeriodEndUtc;
                        currentRegularPeriodStartUtc = new Date(currentRegularPeriodEndUtc.getTime() + 1);
                    }

                    writeOperations.challengeSuccessCount = successCount;
                    writeOperations.challengeFailureCount = failureCount;
                    if (lastProcessedPeriodEndDateUtc && (!blogData.lastProcessedPeriodEndDate || new Date(blogData.lastProcessedPeriodEndDate) < lastProcessedPeriodEndDateUtc) ) {
                        writeOperations.lastProcessedPeriodEndDate = lastProcessedPeriodEndDateUtc.toISOString();
                    }
                    
                    finalSuccessCount = successCount;
                    finalFailureCount = failureCount;
                    finalIsActive = isCurrentPeriod && hasPostInCurrentPeriod;
                    writeOperations.isActive = finalIsActive;

                    if (!blogData.lastProcessedPeriodEndDate && finalIsActive && successCount === 0 && failureCount === 0) {
                        writeOperations.challengeSuccessCount = 1;
                        finalSuccessCount = 1;
                    }
                }

                if (Object.keys(writeOperations).length > 0) {
                    await blogsRef.doc(blogId).update(writeOperations);
                    console.log(`[${blogName}] Firestore 업데이트 완료`);
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
                    .catch(err => { console.error(`[${blog.id}] 순위 업데이트 실패:`, err.message); });
            });
            await Promise.all(rankUpdatePromises);
            console.log('블로그 순위 재계산 및 업데이트 완료.');
        }

        return res.status(200).json({
            message: `모든 업데이트 완료. RSS 성공: ${successfulRssUpdates}, RSS 실패: ${failedRssUpdates}`,
            updatedCount: successfulRssUpdates,
            errorCount: failedRssUpdates
        });

    } catch (finalError) {
        console.error('전체 RSS 업데이트 프로세스 중 심각한 오류 발생:', finalError);
        return res.status(500).json({
            error: '전체 RSS 업데이트 프로세스 중 심각한 오류 발생',
            details: String(finalError.message),
            updatedCount: successfulRssUpdates,
            errorCount: failedRssUpdates
        });
    }
};
